//! 轻量模型指纹：用实际响应里能拿到的稳定元数据生成短 ID。
//!
//! 它不是模型权重哈希，也不是不可伪造证明；用途是发现“配的模型和响应模型不一致”、
//! 网关换后端、system_fingerprint 变化等异常。

use sha2::{Digest, Sha256};

use super::store::Provider;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    pub id: String,
    pub model: String,
    pub system: String,
    pub source: String,
}

fn endpoint_host(endpoint: &str) -> String {
    url::Url::parse(endpoint.trim())
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_ascii_lowercase()))
        .unwrap_or_default()
}

pub fn compute(provider: &Provider, response_model: &str, system_fingerprint: &str) -> Fingerprint {
    let observed = response_model.trim();
    let model = if observed.is_empty() {
        provider.model.trim().to_string()
    } else {
        observed.to_string()
    };
    let system = system_fingerprint.trim().to_string();
    let protocol = provider.kind.trim().to_ascii_lowercase();
    let canonical = format!(
        "v1\n{protocol}\n{}\n{model}\n{system}",
        endpoint_host(&provider.endpoint)
    );
    let digest = Sha256::digest(canonical.as_bytes());
    let hex = format!("{digest:x}");
    let source = if observed.is_empty() {
        "configured"
    } else if system.is_empty() {
        "model"
    } else {
        "model+system"
    };
    Fingerprint {
        id: format!("fp-{}", &hex[..8]),
        model,
        system,
        source: source.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::store::Provider;

    fn provider(model: &str) -> Provider {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "p", "endpoint": "https://api.example.com/v1", "model": model,
        }))
        .unwrap()
    }

    #[test]
    fn fingerprint_is_stable_and_changes_with_observed_metadata() {
        let p = provider("deepseek-flash");
        let a = compute(&p, "deepseek-flash", "fp_backend_1");
        let b = compute(&p, "deepseek-flash", "fp_backend_1");
        let c = compute(&p, "deepseek-flash", "fp_backend_2");
        let d = compute(&p, "deepseek-v4-pro", "fp_backend_1");
        assert_eq!(a, b);
        assert_ne!(a.id, c.id, "system_fingerprint 变化应该反映到指纹");
        assert_ne!(a.id, d.id, "实际模型变化应该反映到指纹");
        assert_eq!(a.id.len(), 11);
        assert!(a.id.starts_with("fp-"));
    }

    #[test]
    fn missing_response_model_falls_back_to_configured_model() {
        let p = provider("deepseek-flash");
        let f = compute(&p, "", "");
        assert_eq!(f.model, "deepseek-flash");
        assert_eq!(f.source, "configured");
    }
}
