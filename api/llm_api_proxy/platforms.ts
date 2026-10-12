/**
 * 平台配置表
 *
 * 新增平台只需在这里加一行：
 *   平台名: { endpoint: "上游地址", label: "显示名" }
 *
 * 要求上游接口兼容 OpenAI 的 /v1/chat/completions 规范。
 * API Key 由客户端在 Authorization 请求头中携带，服务端不存储。
 */
export interface Platform {
    endpoint: string;
    label: string;
}

export const PLATFORMS: Record<string, Platform> = {
    openai: {
        endpoint: "https://api.openai.com/v1/chat/completions",
        label: "OpenAI",
    },
    deepseek: {
        endpoint: "https://api.deepseek.com/v1/chat/completions",
        label: "DeepSeek",
    },
    openrouter: {
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        label: "OpenRouter",
    },
    siliconflow: {
        endpoint: "https://api.siliconflow.cn/v1/chat/completions",
        label: "硅基流动",
    },
    zhipu: {
        endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        label: "智谱 GLM",
    },
    moonshot: {
        endpoint: "https://api.moonshot.cn/v1/chat/completions",
        label: "Moonshot",
    },
    dashscope: {
        endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        label: "通义千问",
    },
    groq: {
        // Groq 官方接口本身即 OpenAI 兼容
        endpoint: "https://api.groq.com/openai/v1/chat/completions",
        label: "Groq",
    },
};

/** 返回所有受支持的平台名 */
export function listPlatforms(): string[] {
    return Object.keys(PLATFORMS);
}
