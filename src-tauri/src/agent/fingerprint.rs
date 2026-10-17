//! 模型指纹 -> 实际模型名。
//!
//! 这些映射来自公开的接口指纹记录，不是模型权重哈希。未知指纹统一显示 `unknown`，
//! 避免把“deepseek-flash”这类通用别名误当成具体版本。

use super::store::Provider;

/// 已知 `system_fingerprint` 对应关系。
/// e72d3c7f...：2026-10-17 的 DeepSeek V4.1 Flash 1017 更新。
/// aeb56401...：更新前的 DeepSeek V4.1 Flash。
const KNOWN_FINGERPRINTS: &[(&str, &str)] = &[
    (
        "e72d3c7f663d3e1383b00b3884cb4501",
        "DeepSeek-V4.1-Flash-1017",
    ),
    (
        "aeb56401ca74e127821c4f9126dcb669",
        "DeepSeek-V4.1-Flash",
    ),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    /// 给用户看的真实模型名，无法识别时为 unknown。
    pub name: String,
    /// 响应里声明的模型（通常还是通用别名）。
    pub model: String,
    /// 原始 system_fingerprint。
    pub system: String,
}

fn known(system: &str) -> Option<&'static str> {
    let key = system.trim().to_ascii_lowercase();
    KNOWN_FINGERPRINTS
        .iter()
        .find(|(fp, _)| *fp == key)
        .map(|(_, name)| *name)
}

fn generic_alias(model: &str) -> bool {
    matches!(
        model.trim().to_ascii_lowercase().as_str(),
        "deepseek-flash" | "deepseek-chat" | "deepseek-reasoner"
    )
}

pub fn compute(provider: &Provider, response_model: &str, system_fingerprint: &str) -> Fingerprint {
    let observed = response_model.trim();
    let model = if observed.is_empty() {
        provider.model.trim().to_string()
    } else {
        observed.to_string()
    };
    let system = system_fingerprint.trim().to_string();
    let name = if let Some(name) = known(&system) {
        name.to_string()
    } else if !system.is_empty() {
        "unknown".to_string()
    } else if !model.is_empty() && !generic_alias(&model) {
        model.clone()
    } else {
        "unknown".to_string()
    };
    Fingerprint {
        name,
        model,
        system,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider(model: &str) -> Provider {
        serde_json::from_value(serde_json::json!({
            "id": "p", "name": "p", "endpoint": "https://api.example.com/v1", "model": model,
        }))
        .unwrap()
    }

    #[test]
    fn maps_known_deepseek_fingerprints_to_model_names() {
        let p = provider("deepseek-flash");
        let current = compute(
            &p,
            "deepseek-flash",
            "e72d3c7f663d3e1383b00b3884cb4501",
        );
        let previous = compute(
            &p,
            "deepseek-flash",
            "aeb56401ca74e127821c4f9126dcb669",
        );
        assert_eq!(current.name, "DeepSeek-V4.1-Flash-1017");
        assert_eq!(previous.name, "DeepSeek-V4.1-Flash");
    }

    #[test]
    fn unknown_fingerprint_is_explicit() {
        let p = provider("deepseek-flash");
        let f = compute(&p, "deepseek-flash", "ffffffffffffffffffffffffffffffff");
        assert_eq!(f.name, "unknown");
        assert_eq!(f.system, "ffffffffffffffffffffffffffffffff");
    }

    #[test]
    fn generic_alias_without_fingerprint_is_unknown() {
        let p = provider("deepseek-flash");
        assert_eq!(compute(&p, "deepseek-flash", "").name, "unknown");
        assert_eq!(
            compute(&p, "gpt-4o-2024-08-06", "").name,
            "gpt-4o-2024-08-06"
        );
    }
}
