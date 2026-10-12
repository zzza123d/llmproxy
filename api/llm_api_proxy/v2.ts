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

    // 基于「路径 + 请求体哈希」做边缘缓存，避免重复调用消耗上游配额
    const cacheUrl = new URL(req.url);
    const hash = await sha256(body);
    cacheUrl.pathname = `/cache/${platform}/${hash}`;
    cacheUrl.search = '';
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    const cache = caches.default;

    const hit = await cache.match(cacheKey);
    if (hit) {
        const res = new Response(hit.body, hit);
        res.headers.set('x-llmproxy-cache', 'HIT');
        return res;
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
        const headers = new Headers(forCache.headers);
        headers.set('cache-control', 'max-age=300');
        const cached = new Response(forCache.body, {
            status: forCache.status,
            statusText: forCache.statusText,
            headers,
        });
        ctx.waitUntil(cache.put(cacheKey, cached));
    }

    const out = new Response(upstream.body, upstream);
    out.headers.set('x-llmproxy-cache', 'MISS');
    out.headers.set('x-llmproxy-platform', platform);
    return out;
}

export async function fetch(
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
    if (platform === 'platforms') {
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
