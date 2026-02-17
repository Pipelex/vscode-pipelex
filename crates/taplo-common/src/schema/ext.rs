use serde::{Deserialize, Serialize};
use serde_json::Value;
use tap::TapFallible;

pub const EXTENSION_KEY: &str = "x-taplo";
pub const PLXT_EXTENSION_KEY: &str = "x-plxt";

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct TaploSchemaExt {
    pub hidden: Option<bool>,
    pub links: Option<ExtLinks>,
    pub docs: Option<ExtDocs>,
    pub init_keys: Option<Vec<String>>,
    #[serde(default)]
    pub plugins: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ExtDocs {
    pub main: Option<String>,
    pub const_value: Option<String>,
    pub default_value: Option<String>,
    pub enum_values: Option<Vec<Option<String>>>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ExtLinks {
    pub key: Option<String>,
    pub enum_values: Option<Vec<Option<String>>>,
}

fn try_schema_ext(schema: &Value, key: &str) -> Option<TaploSchemaExt> {
    schema.get(key).and_then(|val| {
        if val.is_object() {
            serde_json::from_value(val.clone())
                .tap_err(|error| tracing::warn!(%key, %error, "invalid schema extension"))
                .ok()
        } else {
            None
        }
    })
}

#[must_use]
pub fn schema_ext_of(schema: &Value) -> Option<TaploSchemaExt> {
    try_schema_ext(schema, PLXT_EXTENSION_KEY)
        .or_else(|| try_schema_ext(schema, EXTENSION_KEY))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plxt_takes_priority_over_taplo() {
        let schema = json!({
            "x-plxt": { "docs": { "main": "plxt docs" } },
            "x-taplo": { "docs": { "main": "taplo docs" } },
        });
        let ext = schema_ext_of(&schema).unwrap();
        assert_eq!(ext.docs.unwrap().main.unwrap(), "plxt docs");
    }

    #[test]
    fn falls_back_to_taplo_when_plxt_absent() {
        let schema = json!({
            "x-taplo": { "docs": { "main": "taplo docs" } },
        });
        let ext = schema_ext_of(&schema).unwrap();
        assert_eq!(ext.docs.unwrap().main.unwrap(), "taplo docs");
    }

    #[test]
    fn plxt_alone_works() {
        let schema = json!({
            "x-plxt": { "hidden": true },
        });
        let ext = schema_ext_of(&schema).unwrap();
        assert_eq!(ext.hidden, Some(true));
    }

    #[test]
    fn no_extension_returns_none() {
        let schema = json!({ "type": "string" });
        assert!(schema_ext_of(&schema).is_none());
    }

    #[test]
    fn non_object_plxt_falls_through_to_taplo() {
        let schema = json!({
            "x-plxt": "not an object",
            "x-taplo": { "docs": { "main": "taplo docs" } },
        });
        let ext = schema_ext_of(&schema).unwrap();
        assert_eq!(ext.docs.unwrap().main.unwrap(), "taplo docs");
    }

    #[test]
    fn malformed_plxt_object_falls_back_to_taplo() {
        let schema = json!({
            "x-plxt": { "hidden": "not a bool" },
            "x-taplo": { "docs": { "main": "taplo docs" } },
        });
        let ext = schema_ext_of(&schema).unwrap();
        assert_eq!(ext.docs.unwrap().main.unwrap(), "taplo docs");
    }
}
