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
 * 规范化平台表：转成「无原型」对象。
 * 这样 REGISTRY["constructor"] / ["toString"] / ["__proto__"] 等
 * 原型链属性名一律返回 undefined，不会误判为有效平台。
 *
 * 同时做一次自检：只保留 endpoint 为合法 http(s) 字符串的条目，
 * 防止 platforms.ts 里写错地址导致 fetch 抛 "Invalid URL string."
 */
const REGISTRY: Record<string, { endpoint: string; label: string }> = (() => {
    const out: Record<string, { endpoint: string; label: string }> = Object.create(null);
    let ids: string[] = [];
    try {
        ids = listPlatforms();
    } catch (e) {
        ids = [];
    }
    for (const id of ids) {
        const raw = (PLATFORMS as any)[id];
        if (!raw) continue;
        const endpoint = String(raw.endpoint || '');
        if (!/^https?:\/\//i.test(endpoint)) continue; // 跳过非法地址
        out[id] = { endpoint, label: String(raw.label || id) };
    }
    return out;
})();

/** 安全取平台配置，只认自有属性 */
function lookup(platform: string | undefined): { endpoint: string; label: string } | undefined {
    if (!platform) return undefined;
    if (!Object.prototype.hasOwnProperty.call(REGISTRY, platform)) return undefined;
    const c = REGISTRY[platform];
    if (!c || typeof c.endpoint !== 'string') return undefined;
    return c;
}

/** 所有平台的 id 列表（同样基于无原型对象） */
function allPlatformIds(): string[] {
    return Object.keys(REGISTRY);
}

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

/**
 * 构造缓存键。
 * 返回 Request，但全程用 try/catch 包裹——任何一个 URL 解析点失败
 * 都退化为「不使用缓存」，绝不能让它冒泡成 worker 异常。
 */
function buildCacheKey(platform: string, hash: string): Request | null {
    try {
        const u = new URL('https://llmproxy.internal/');
        u.pathname = `/cache/${encodeURIComponent(platform || 'unknown')}/${encodeURIComponent(hash || 'nohash')}`;
        return new Request(u.toString(), { method: 'GET' });
    } catch (e) {
        return null; // 放弃缓存
    }
}

/** 统一转发：适用于所有 OpenAI 兼容平台 */
async function openaiCompat(
    req: Request,
    ctx: ExecutionContext,
    endpoint: string,
    platform: string
): Promise<Response> {
    let body = '';
    try {
        body = await req.clone().text();
    } catch (e) {
        body = '';
    }

    // 基于「请求体哈希」做边缘缓存，避免重复调用消耗上游配额。
    // 缓存全程容错：任何一步失败都直接跳过缓存，走真实请求。
    let cacheKey: Request | null = null;
    let cache: Cache | null = null;
    try {
        const hash = await sha256(body);
        cacheKey = buildCacheKey(platform, hash);
        cache = caches.default;
    } catch (e) {
        cacheKey = null;
        cache = null;
    }

    if (cacheKey && cache) {
        let hit: Response | undefined;
        try {
            hit = await cache.match(cacheKey);
        } catch (e) {
            hit = undefined;
        }
        if (hit) {
            try {
                return rewrap(hit, { 'x-llmproxy-cache': 'HIT' });
            } catch (e) {
                // 缓存响应包装失败，忽略，继续走真实请求
            }
        }
    }

    // 关键防御：endpoint 必须是合法的 http(s) 绝对地址，
    // 否则 fetch() 内部解析 URL 会抛 TypeError: Invalid URL string.
    if (typeof endpoint !== 'string' || !/^https?:\/\//i.test(endpoint)) {
        return new Response(
            JSON.stringify({
                error: {
                    message: `Upstream endpoint for "${platform}" is invalid: ${String(endpoint)}`,
                    type: 'invalid_request_error',
                },
            }),
            { status: 500, headers: { 'content-type': 'application/json' } }
        );
    }

    // 注意：必须用 globalThis.fetch！
    // 本模块导出了 `export async function fetch`，模块内的裸 `fetch(...)`
    // 会被这个本地声明遮蔽（shadowing），导致递归调用自己——
    // endpoint 字符串被当成 req 传入，req.url 为 undefined，
    // 最终 new URL(undefined) 抛 TypeError: Invalid URL string.
    const upstream = await globalThis.fetch(endpoint, {
        method: 'POST',
        headers: passthroughHeaders(req),
        body: body || undefined,
        redirect: 'follow',
    });

    // 仅缓存成功响应，且不缓存流式输出
    try {
        const isStream = (upstream.headers.get('content-type') || '').includes('event-stream');
        if (cacheKey && cache && upstream.ok && !isStream) {
            const forCache = upstream.clone();
            const cacheHeaders = new Headers(forCache.headers);
            cacheHeaders.set('cache-control', 'max-age=300');
            const cached = new Response(forCache.body, {
                status: forCache.status,
                statusText: forCache.statusText || undefined,
                headers: cacheHeaders,
            });
            ctx.waitUntil(cache.put(cacheKey, cached));
        }
    } catch (e) {
        // 写缓存失败不影响正常返回
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
        let reqUrl = '<unreadable>';
        try {
            reqUrl = String(req.url);
        } catch (e2) {
            reqUrl = '<req.url threw>';
        }
        return new Response(
            JSON.stringify({
                error: {
                    message: e && e.message ? e.message : String(e),
                    type: 'worker_exception',
                    reqUrl,
                    stack: e && e.stack ? String(e.stack).split('\n').slice(0, 10) : undefined,
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
    // 防御：req.url 在极端情况下可能不是合法绝对 URL，
    // 直接 new URL(req.url) 会抛 "Invalid URL string."。
    let url: URL;
    try {
        url = new URL(req.url);
    } catch (e) {
        // 退而求其次：手工从 req.url 里抠出 pathname
        const raw = String(req.url || '');
        const m = /\/(v2|v1)(\/[^?#]*)?/.exec(raw);
        const fallbackPath = m ? (m[1] + (m[2] || '')) : '';
        url = new URL('https://llmproxy.invalid/' + fallbackPath.replace(/^\//, ''));
    }
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
    if (platform === 'platforms' || platform === undefined || platform === '') {
        const names = allPlatformIds();
        return new Response(
            JSON.stringify({
                object: 'list',
                count: names.length,
                data: names.map((name) => ({
                    id: name,
                    label: REGISTRY[name].label,
                    upstream: REGISTRY[name].endpoint,
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

    // 其余全部按 OpenAI 兼容处理（lookup 只认自有属性，杜绝原型链误判）
    const conf = lookup(platform);
    if (!conf) {
        return new Response(
            JSON.stringify({
                error: {
                    message:
                        `Unknown platform "${platform}". ` +
                        `Supported: ${allPlatformIds().join(', ')}, gemini.`,
                    type: 'invalid_request_error',
                },
            }),
            { status: 404, headers: { 'content-type': 'application/json' } }
        );
    }

    return await openaiCompat(req, ctx, conf.endpoint, platform);
}
