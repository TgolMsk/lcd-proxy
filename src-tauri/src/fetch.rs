//! 下载订阅和规则文件。在 Rust 侧发请求,避开 WebView 的 CORS 限制。
//! 报错时去掉网址:订阅链接里带着用户的令牌,不能出现在界面和日志里。

use std::time::Duration;

use serde::Serialize;

const MAX_BODY: usize = 32 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    body: String,
    user_info: Option<String>,
    update_interval: Option<String>,
    disposition: Option<String>,
    web_page: Option<String>,
    title: Option<String>,
    via_proxy: bool,
}

fn header(response: &reqwest::Response, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

async fn download(url: &str, proxy_port: Option<u16>) -> Result<Fetched, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("clash.meta/1.19.0 (LCD Proxy ", env!("CARGO_PKG_VERSION"), ")"))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30));
    if let Some(port) = proxy_port {
        let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
            .map_err(|e| format!("创建代理失败:{e}"))?;
        builder = builder.proxy(proxy);
    }
    let client = builder
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败:{e}"))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("请求失败:{}", e.without_url()))?;
    if !response.status().is_success() {
        return Err(format!("服务器返回 HTTP {}", response.status().as_u16()));
    }
    let user_info = header(&response, "subscription-userinfo");
    let update_interval = header(&response, "profile-update-interval");
    let disposition = header(&response, "content-disposition");
    let web_page = header(&response, "profile-web-page-url");
    let title = header(&response, "profile-title");

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取响应失败:{}", e.without_url()))?
    {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("响应内容过大".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Fetched {
        body: String::from_utf8_lossy(&body).into_owned(),
        user_info,
        update_interval,
        disposition,
        web_page,
        title,
        via_proxy: proxy_port.is_some(),
    })
}

/// 先按系统网络访问。失败且内核在运行时经本地代理重试:
/// 不少机场的订阅域名在国内直连不通。
pub async fn fetch(url: &str, proxy_port: Option<u16>) -> Result<Fetched, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("链接必须以 http:// 或 https:// 开头".into());
    }
    match download(url, None).await {
        Ok(fetched) => Ok(fetched),
        Err(error) => match proxy_port {
            Some(port) => download(url, Some(port))
                .await
                .map_err(|retry| format!("{error};经代理重试也失败:{retry}")),
            None => Err(error),
        },
    }
}
