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
const ATLAS_JSON: &str = include_str!("model_dna_atlas.json");

#[derive(Debug, Deserialize)]
struct Mapping {
    model: String,
}

#[derive(Debug, Deserialize)]
struct Registry {
    checkpoint_mappings: BTreeMap<String, Mapping>,
}

#[derive(Debug, Deserialize)]
struct AtlasFamily {
    #[serde(default)]
    #[cfg_attr(not(test), allow(dead_code))]
    id: String,
    display_name: String,
    #[serde(default, rename = "match")]
    match_terms: Vec<String>,
    #[serde(default)]
    #[cfg_attr(not(test), allow(dead_code))]
    model_ids: Vec<String>,
    source: String,
}

#[derive(Debug, Deserialize)]
struct Atlas {
    #[serde(default)]
    modeldna_families: Vec<AtlasFamily>,
    #[serde(default)]
    provenance_families: Vec<AtlasFamily>,
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

fn atlas() -> &'static Atlas {
    static ATLAS: OnceLock<Atlas> = OnceLock::new();
    &ATLAS.get_or_init(|| {
        serde_json::from_str::<Atlas>(ATLAS_JSON).unwrap_or(Atlas {
            modeldna_families: Vec::new(),
            provenance_families: Vec::new(),
        })
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
    /// 公开 atlas 匹配出的模型族；空表示无法确认。
    pub family: String,
    /// 模型族数据来源（ModelDNA / Model Provenance Kit）。
    pub family_source: String,
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

fn normalize_model(model: &str) -> String {
    model
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn resolve_family(model: &str) -> (String, String) {
    let haystack = format!(" {} ", normalize_model(model));
    let ignored = ["org", "ai", "the", "model", "family", "hf", "chat", "base", "instruct"];
    let mut best: Option<(usize, u8, &AtlasFamily, String)> = None;
    let groups = [
        (&atlas().provenance_families, 2u8, "Model Provenance Kit"),
        (&atlas().modeldna_families, 1u8, "ModelDNA Atlas"),
    ];
    for (families, priority, source_name) in groups {
        for family in families {
            for term in &family.match_terms {
                let term = term.trim().to_ascii_lowercase();
                if term.len() < 3 || ignored.contains(&term.as_str()) {
                    continue;
                }
                if !haystack.contains(&format!(" {term} ")) {
                    continue;
                }
                let score = (term.len(), priority);
                if best
                    .as_ref()
                    .map(|(len, p, _, _)| score > (*len, *p))
                    .unwrap_or(true)
                {
                    best = Some((
                        score.0,
                        score.1,
                        family,
                        if family.source.is_empty() {
                            source_name.to_string()
                        } else {
                            family.source.clone()
                        },
                    ));
                }
            }
        }
    }
    best.map(|(_, _, f, source)| (f.display_name.clone(), source))
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
    let (mut family, mut family_source) = resolve_family(&name);
    if family.is_empty() && name == "unknown" {
        (family, family_source) = resolve_family(&model);
    }
    Fingerprint {
        name,
        model,
        system,
        family,
        family_source,
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
    fn maps_new_deepseek_flash_backend_fingerprint() {
        let p = provider("deepseek-flash");
        let f = compute(
            &p,
            "deepseek-flash",
            "bc19ba97cbe016479903222bb1578db6",
        );
        assert_eq!(f.name, "DeepSeek-V4.1-Flash");
        assert_eq!(f.family, "DeepSeek");
        assert_eq!(f.family_source, "provenance-kit");
    }

    #[test]
    fn maps_known_kimi_fingerprints_to_checkpoint_names() {
        let p = provider("kimi-k2.5");
        assert_eq!(
            compute(&p, "moonshotai/kimi-k2.5-0127", "fpv0_e0c12c89").name,
            "moonshotai/kimi-k2.5-0127"
        );
        assert_eq!(
            compute(&p, "moonshotai/kimi-k2.6-20260420", "fpv0_8cab9aba").name,
            "moonshotai/kimi-k2.6-20260420"
        );
        assert_eq!(
            compute(&p, "kimi-k2-0905-preview", "fpv0_e76aa377").name,
            "kimi-k2-0905-preview"
        );
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

    #[test]
    fn atlas_resolves_kimi_glm_mimo_and_deepseek_families() {
        assert_eq!(atlas().provenance_families.len(), 39);
        assert_eq!(atlas().modeldna_families.len(), 32);
        assert!(atlas()
            .provenance_families
            .iter()
            .any(|f| f.match_terms.iter().any(|t| t == "deepseek")));
        let p = provider("x");
        assert_eq!(compute(&p, "kimi-k2.5", "").family, "Moonshot Kimi (K2, Kimi-Linear)");
        assert_eq!(compute(&p, "glm-5.3", "").family, "GLM");
        assert_eq!(compute(&p, "mimo-v2.5", "").family, "Xiaomi MiMo V2.x");
        assert_eq!(compute(&p, "deepseek-flash", "").family, "DeepSeek");
    }

    #[test]
    fn atlas_snapshot_has_unique_and_complete_coverage() {
        let atlas = atlas();
        let modeldna_ids: std::collections::BTreeSet<_> = atlas
            .modeldna_families
            .iter()
            .map(|family| family.id.as_str())
            .collect();
        let provenance_ids: std::collections::BTreeSet<_> = atlas
            .provenance_families
            .iter()
            .map(|family| family.id.as_str())
            .collect();
        let model_ids: Vec<_> = atlas
            .provenance_families
            .iter()
            .flat_map(|family| family.model_ids.iter().map(String::as_str))
            .collect();
        let unique_model_ids: std::collections::BTreeSet<_> = model_ids.iter().copied().collect();

        assert_eq!(modeldna_ids.len(), 32);
        assert_eq!(provenance_ids.len(), 39);
        assert_eq!(model_ids.len(), 184);
        assert_eq!(unique_model_ids.len(), 184);
    }
}
