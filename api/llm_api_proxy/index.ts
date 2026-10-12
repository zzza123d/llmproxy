import { fetch as fetchV1 } from "./v1";
import { fetch as fetchV2 } from "./v2";
import { Env } from "./types";

export default {
	async fetch(
		req: Request,
		env: Env,
		ctx: ExecutionContext): Promise<Response> {
		const pathname = new URL(req.url).pathname;
		const segments = pathname.split("/").filter((s) => s.length > 0);
		const version = segments[0];

		// 根路径 / => 返回服务信息，方便自检
		if (segments.length === 0) {
			return new Response(
				JSON.stringify({
					service: "llmproxy",
					status: "ok",
					hint: "GET /v2/platforms 查看支持的平台",
				}, null, 2),
				{ headers: { "content-type": "application/json" } }
			);
		}

		try {
			switch (version) {
				case "v2":
					return await fetchV2(req, env, ctx);
				default:
					return await fetchV1(req, env, ctx);
			}
		} catch (e: any) {
			return new Response(
				JSON.stringify({
					error: {
						message: e && e.message ? e.message : String(e),
						type: "router_exception",
					},
				}),
				{ status: 500, headers: { "content-type": "application/json" } }
			);
		}
	}
}
