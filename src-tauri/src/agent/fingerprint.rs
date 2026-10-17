//! 模型指纹 -> 实际模型名。
//!
//! 只有能确认指向具体 checkpoint 的指纹才做版本映射（目前主要是 DeepSeek）。
//! `vllm-...`、`fp_...` 这类是服务栈/部署指纹，不冒充模型版本，改用响应里的
//! 具体 `model`；只有两者都给不出具体名称时才显示 `unknown`。

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

use super::store::Provider;

const REGISTRY_JSON: &str = include_str!("model_fingerprints.json");

#[derive(Debug, Deserialize)]
struct Mapping {
    model: String,
}

#[derive(Debug, Deserialize)]
struct Registry {
    checkpoint_mappings: BTreeMap<String, Mapping>,
}

fn registry() -> &'static BTreeMap<String, Mapping> {
    static REGISTRY: OnceLock<BTreeMap<String, Mapping>> = OnceLock::new();
    &REGISTRY
        .get_or_init(|| {
            serde_json::from_str::<Registry>(REGISTRY_JSON)
                .map(|r| r.checkpoint_mappings)
                .unwrap_or_default()
        })
}

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
    registry().get(&key).map(|m| m.model.as_str())
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
    let name = known(&system)
        .map(ToString::to_string)
        .or_else(|| {
            if !model.is_empty() && !generic_alias(&model) {
                Some(model.clone())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "unknown".to_string());
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

    #[test]
    fn serving_stack_fingerprint_uses_specific_response_model() {
        let p = provider("glm-5.3");
        let f = compute(&p, "glm-5.3", "vllm-0.23.0-tp8-ep-7f569517");
        assert_eq!(f.name, "glm-5.3");
    }

    #[test]
    fn registry_covers_requested_vendors() {
        let v: serde_json::Value = serde_json::from_str(REGISTRY_JSON).unwrap();
        for name in ["mimo", "glm", "deepseek", "kimi", "claude", "gpt", "grok"] {
            assert!(v["vendors"].get(name).is_some(), "缺少 {name}");
        }
    }
}
