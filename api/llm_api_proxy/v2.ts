/**
 * v2 路由
 *
 * 路径格式：/v2/{platform}/v1/chat/completions
 *
 * 设计：所有 OpenAI 兼容平台共用同一个转发逻辑（openaiCompat），
 * 只有 Gemini 因为上游协议不同，单独处理。
 *
 * 新增平台：在 platforms.ts 里加一行即可，无需改本文件。
 */
import { sha256 } from './utils';
import { Env } from './types';
import { PLATFORMS, listPlatforms } from './platforms';
import { GeminiInferece } from './models';

/**
 * 安全地把上游 Response 包装成新 Response。
 * 关键：不能把 Response 直接当 ResponseInit 传——当上游 status 为 0
 * （网络层失败 / 被中断）时，`new Response(body, {status:0})` 会抛
 * RangeError，进而导致 Cloudflare ERROR 1101。
 */
function rewrap(src: Response, extraHeaders?: Record<string, string>): Response {
    const headers = new Headers(src.headers);
    if (extraHeaders) {
        for (const k of Object.keys(extraHeaders)) headers.set(k, extraHeaders[k]);
    }
    // status 必须落在 200–599，否则构造会抛异常
    let status = src.status;
    if (!Number.isInteger(status) || status < 200 || status > 599) {
        status = 502;
    }
    return new Response(src.body, {
        status,
        statusText: src.statusText || undefined,
        headers,
    });
}

/** 需要透传给上游、且不参与缓存的请求头 */
function passthroughHeaders(req: Request): Headers {
    const h = new Headers();
    const auth = req.headers.get('authorization');
    const ct = req.headers.get('content-type');
    const accept = req.headers.get('accept');
    if (auth) h.set('authorization', auth);
    h.set('content-type', ct || 'application/json');
    if (accept) h.set('accept', accept);
    return h;
}

/** 统一转发：适用于所有 OpenAI 兼容平台 */
async function openaiCompat(
    req: Request,
    ctx: ExecutionContext,
    endpoint: string,
    platform: string
): Promise<Response> {
    const body = await req.clone().text();

    // 基于「请求体哈希」做边缘缓存，避免重复调用消耗上游配额。
    // 注意：cacheKey 用固定 origin，避免污染用户请求 URL。
    const hash = await sha256(body);
    const cacheKey = new Request(`https://llmproxy.internal/cache/${platform}/${hash}`, {
        method: 'GET',
    });
    const cache = caches.default;

    let hit: Response | undefined;
    try {
        hit = await cache.match(cacheKey);
    } catch (e) {
        // 缓存不可用时忽略，继续走真实请求
        hit = undefined;
    }
    if (hit) {
        return rewrap(hit, { 'x-llmproxy-cache': 'HIT' });
    }

    const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: passthroughHeaders(req),
        body: body || undefined,
        redirect: 'follow',
    });

    // 仅缓存成功响应，且不缓存流式输出
    const isStream = (upstream.headers.get('content-type') || '').includes('event-stream');
    if (upstream.ok && !isStream) {
        const forCache = upstream.clone();
        const cacheHeaders = new Headers(forCache.headers);
        cacheHeaders.set('cache-control', 'max-age=300');
        const cached = new Response(forCache.body, {
            status: forCache.status,
            statusText: forCache.statusText || undefined,
            headers: cacheHeaders,
        });
        try {
            ctx.waitUntil(cache.put(cacheKey, cached));
        } catch (e) {
            // 写缓存失败不影响正常返回
        }
    }

    return rewrap(upstream, {
        'x-llmproxy-cache': 'MISS',
        'x-llmproxy-platform': platform,
    });
}

export async function fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext
): Promise<Response> {
    try {
        return await route(req, env, ctx);
    } catch (e: any) {
        // 兜底：把未捕获异常转成可读 JSON，避免 Cloudflare ERROR 1101
        return new Response(
            JSON.stringify({
                error: {
                    message: e && e.message ? e.message : String(e),
                    type: 'worker_exception',
                    stack: e && e.stack ? String(e.stack).split('\n').slice(0, 8) : undefined,
                },
            }),
            { status: 500, headers: { 'content-type': 'application/json' } }
        );
    }
}

async function route(
    req: Request,
    env: Env,
    ctx: ExecutionContext
): Promise<Response> {
    const url = new URL(req.url);
    const platform = url.pathname.split('/')[2];

    // 预检请求直接放行
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'access-control-allow-origin': '*',
                'access-control-allow-methods': 'POST, GET, OPTIONS',
                'access-control-allow-headers': 'authorization, content-type',
                'access-control-max-age': '86400',
            },
        });
    }

    // 平台列表接口：GET /v2/platforms
    if (platform === 'platforms' || platform === undefined) {
        return new Response(
            JSON.stringify({
                object: 'list',
                data: listPlatforms().map((name) => ({
                    id: name,
                    label: PLATFORMS[name].label,
                    endpoint: `/v2/${name}/v1/chat/completions`,
                })),
            }),
            { headers: { 'content-type': 'application/json' } }
        );
    }

    // Gemini 协议与 OpenAI 不同，单独走
    if (platform === 'gemini') {
        return await new GeminiInferece().handle(req, env, ctx);
    }

    // 其余全部按 OpenAI 兼容处理
    const conf = PLATFORMS[platform];
    if (!conf) {
        return new Response(
            JSON.stringify({
                error: {
                    message:
                        `Unknown platform "${platform}". ` +
                        `Supported: ${listPlatforms().join(', ')}, gemini.`,
                    type: 'invalid_request_error',
                },
            }),
            { status: 404, headers: { 'content-type': 'application/json' } }
        );
    }

    return await openaiCompat(req, ctx, conf.endpoint, platform);
}
