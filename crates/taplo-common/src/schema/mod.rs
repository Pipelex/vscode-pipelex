use self::{associations::SchemaAssociations, builtins::builtin_schema, cache::Cache};
use crate::{environment::Environment, util::ArcHashValue, LruCache};
use anyhow::{anyhow, Context};
use async_recursion::async_recursion;
use futures::{stream::FuturesUnordered, StreamExt};
use itertools::Itertools;
use json_value_merge::Merge;
use jsonschema::{
    error::ValidationErrorKind,
    output::{BasicOutput, ErrorDescription, OutputUnit},
    paths::PathChunk,
    JSONSchema, SchemaResolver, ValidationError,
};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::Value;
use std::{borrow::Cow, collections::HashMap, num::NonZeroUsize, sync::Arc};
use taplo::{
    dom::{self, node::Key, KeyOrIndex, Keys},
    rowan::TextRange,
};
use thiserror::Error;
use tokio::sync::Semaphore;
use url::Url;

pub mod associations;
pub mod cache;
pub mod ext;

pub mod builtins {
    use serde_json::Value;
    use std::sync::Arc;
    use url::Url;

    pub const TAPLO_CONFIG_URL: &str = "taplo://taplo.toml";

    pub const MTHDS_SCHEMA_URL: &str = "pipelex://mthds.schema.json";

    const MTHDS_SCHEMA_JSON: &str = include_str!("../../schemas/mthds_schema.json");

    #[must_use]
    pub fn taplo_config_schema() -> Arc<Value> {
        Arc::new(serde_json::to_value(schemars::schema_for!(crate::config::Config)).unwrap())
    }

    #[must_use]
    pub fn mthds_schema() -> Arc<Value> {
        Arc::new(
            serde_json::from_str(MTHDS_SCHEMA_JSON).expect("embedded MTHDS schema is invalid JSON"),
        )
    }

    #[must_use]
    pub fn builtin_schema(url: &Url) -> Option<Arc<Value>> {
        match url.as_str() {
            TAPLO_CONFIG_URL => Some(taplo_config_schema()),
            MTHDS_SCHEMA_URL => Some(mthds_schema()),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct Schemas<E: Environment> {
    env: E,
    associations: SchemaAssociations<E>,
    concurrent_requests: Arc<Semaphore>,
    http: reqwest::Client,
    validators: Arc<Mutex<LruCache<Url, Arc<JSONSchema>>>>,
    cache: Cache<E>,
}

impl<E: Environment> Schemas<E> {
    pub fn new(env: E, http: reqwest::Client) -> Self {
        let cache = Cache::new(env.clone());

        Self {
            associations: SchemaAssociations::new(env.clone(), cache.clone(), http.clone()),
            cache,
            env,
            concurrent_requests: Arc::new(Semaphore::new(10)),
            http,
            validators: Arc::new(Mutex::new(LruCache::with_hasher(
                NonZeroUsize::new(3).unwrap(),
                ahash::RandomState::new(),
            ))),
        }
    }

    /// Get a reference to the schemas's associations.
    pub fn associations(&self) -> &SchemaAssociations<E> {
        &self.associations
    }

    /// Get a reference to the schemas's cache.
    pub fn cache(&self) -> &Cache<E> {
        &self.cache
    }

    pub fn env(&self) -> &E {
        &self.env
    }

    /// Clear all in-memory schema caches (LRU cache and compiled validators).
    /// Call this when configuration changes to ensure stale schemas are not reused.
    pub fn clear_caches(&self) {
        self.cache.clear();
        self.validators.lock().clear();
    }
}

/// Build a self-contained sub-schema from a definition name.
/// Copies the definition as the root and includes all definitions for `$ref` resolution.
/// Also copies the `$schema` draft indicator so the validator uses the correct draft.
///
/// Note: clones the entire definitions map into each sub-schema. This is acceptable —
/// the map is small (~35 entries) and this only runs at lint time, not in a hot loop.
fn build_definition_sub_schema(schema: &Value, definition_name: &str) -> Option<Value> {
    let definitions = schema.get("definitions")?.as_object()?;
    let definition = definitions.get(definition_name)?;
    let mut sub_schema = definition.clone();
    if let Some(obj) = sub_schema.as_object_mut() {
        obj.insert(
            "definitions".to_string(),
            Value::Object(definitions.clone()),
        );
        // Copy $schema so the validator uses the correct draft (e.g., draft-04)
        if let Some(draft) = schema.get("$schema") {
            obj.insert("$schema".to_string(), draft.clone());
        }
    }
    Some(sub_schema)
}

impl<E: Environment> Schemas<E> {
    /// MTHDS-specific: validate each pipe individually using the `type` discriminator.
    /// Returns specific leaf errors per pipe, or None if this validation path doesn't apply.
    fn validate_mthds_pipes(
        &self,
        schema_url: &Url,
        root: &dom::Node,
        value: &Value,
    ) -> Option<Vec<NodeValidationError>> {
        if schema_url.as_str() != builtins::MTHDS_SCHEMA_URL {
            return None;
        }

        // Load the full MTHDS schema (already cached)
        let schema = self.cache().get_schema(schema_url)?;

        // Navigate DOM to pipe table and look up the "pipe" key once.
        // If there's no [pipe.*] section in the .mthds file, the `?` returns None,
        // which skips the MTHDS path entirely. The generic AnyOf expansion then
        // handles whatever errors exist (e.g., in the concept section). This is intentional.
        let root_table = root.as_table()?;
        let pipe_dom_node = root_table.get("pipe")?;
        let pipe_dom_table = pipe_dom_node.as_table()?;

        let pipe_table_key = {
            let entries = root_table.entries().read();
            let found = entries
                .iter()
                .find(|(k, _)| k.value() == "pipe")
                .map(|(k, _)| k.clone());
            found?
        };

        // Navigate JSON to pipe object
        let pipe_json = value.get("pipe")?.as_object()?;

        let mut all_errors = Vec::new();

        // Cache compiled validators by definition name so pipes of the same type
        // reuse the same compiled schema instead of recompiling per pipe.
        let mut validator_cache: HashMap<String, Arc<JSONSchema>> = HashMap::new();

        // Collect entries upfront to release the read lock before calling validate_single_pipe
        let pipe_entries: Vec<_> = {
            let entries = pipe_dom_table.entries().read();
            entries
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        };

        for (dom_key, pipe_dom_node) in &pipe_entries {
            let pipe_name = dom_key.value();

            // Get the corresponding JSON value
            let Some(pipe_value) = pipe_json.get(pipe_name) else {
                continue;
            };

            // Read the `type` string from the DOM
            let type_str = match pipe_dom_node.as_table() {
                Some(t) => match t.get("type") {
                    Some(type_node) => match type_node.as_str() {
                        Some(s) => s.value().to_string(),
                        None => continue,
                    },
                    None => continue,
                },
                None => continue,
            };

            // Map to definition name: "{type}Blueprint"
            let definition_name = format!("{type_str}Blueprint");

            // Get or compile the validator for this definition
            let validator = match validator_cache.get(&definition_name) {
                Some(v) => v.clone(),
                None => {
                    let Some(sub_schema) = build_definition_sub_schema(&schema, &definition_name)
                    else {
                        continue; // Unknown type — let generic validator handle it
                    };
                    match self.create_validator(&sub_schema) {
                        Ok(v) => {
                            let v = Arc::new(v);
                            validator_cache.insert(definition_name, v.clone());
                            v
                        }
                        Err(err) => {
                            tracing::warn!(
                                %pipe_name, %err,
                                "failed to compile validator for pipe type"
                            );
                            continue;
                        }
                    }
                }
            };

            // Validate this pipe against its specific blueprint
            let errors = Self::validate_single_pipe(
                &pipe_table_key,
                dom_key,
                pipe_dom_node,
                pipe_value,
                &validator,
            );
            all_errors.extend(errors);
        }

        Some(all_errors)
    }

    /// Validate a single pipe instance against its pre-compiled blueprint validator.
    /// Returns leaf errors with DOM keys prefixed by the pipe path.
    fn validate_single_pipe(
        pipe_table_key: &Key,
        pipe_dom_key: &Key,
        pipe_dom_node: &dom::Node,
        pipe_value: &Value,
        validator: &JSONSchema,
    ) -> Vec<NodeValidationError> {
        // Build the base keys: [pipe, pipe_name]
        let base_keys = Keys::empty()
            .join(pipe_table_key.clone())
            .join(pipe_dom_key.clone());

        // Run validate() on the pipe value
        let validation_result = validator.validate(pipe_value);
        match validation_result {
            Ok(()) => Vec::new(),
            Err(errors) => {
                let errors: Vec<_> = errors
                    .map(|err| ValidationError {
                        instance: Cow::Owned(err.instance.into_owned()),
                        kind: err.kind,
                        instance_path: err.instance_path,
                        schema_path: err.schema_path,
                    })
                    .collect();

                // Check for AnyOf/OneOf errors that need further expansion
                let has_any_of = errors.iter().any(|e| {
                    matches!(
                        e.kind,
                        ValidationErrorKind::AnyOf | ValidationErrorKind::OneOfNotValid
                    )
                });

                if has_any_of {
                    // Use apply().basic() for detailed leaf errors
                    let output = validator.apply(pipe_value).basic();
                    if let BasicOutput::Invalid(units) = output {
                        let expanded =
                            Self::expand_any_of_errors(&base_keys, pipe_dom_node, &units);
                        if !expanded.is_empty() {
                            // Return expanded errors + non-AnyOf/OneOf direct errors
                            let mut result: Vec<_> = errors
                                .into_iter()
                                .filter(|e| {
                                    !matches!(
                                        e.kind,
                                        ValidationErrorKind::AnyOf
                                            | ValidationErrorKind::OneOfNotValid
                                    )
                                })
                                .filter_map(|e| {
                                    NodeValidationError::new_from(
                                        base_keys.clone(),
                                        pipe_dom_node,
                                        e,
                                    )
                                    .ok()
                                })
                                .collect();
                            result.extend(expanded);
                            return result;
                        }
                    }
                }

                // No AnyOf/OneOf or expansion didn't help — convert errors directly
                errors
                    .into_iter()
                    .filter_map(|e| {
                        NodeValidationError::new_from(base_keys.clone(), pipe_dom_node, e).ok()
                    })
                    .collect()
            }
        }
    }

    #[tracing::instrument(skip_all, fields(%schema_url))]
    pub async fn validate_root(
        &self,
        schema_url: &Url,
        root: &dom::Node,
    ) -> Result<Vec<NodeValidationError>, anyhow::Error> {
        let value = serde_json::to_value(root)?;
        let errors = self.validate(schema_url, &value).await?;

        let mut node_errors: Vec<NodeValidationError> = errors
            .into_iter()
            .filter_map(|error| NodeValidationError::new(root, error).ok())
            .collect();

        // Check if any errors are AnyOf/OneOf — if so, try to expand them
        // with detailed leaf errors from apply().basic().
        //
        // Strategy: use the "best matching branch" heuristic.
        // For each oneOf/anyOf, group leaf errors by branch index and pick
        // the branch with the fewest errors — that's the closest schema match.
        // Only expand if the best branch has few errors (≤ MAX_LEAF_ERRORS),
        // otherwise keep the original AnyOf/OneOf message.
        let has_any_of_errors = node_errors
            .iter()
            .any(NodeValidationError::is_any_of_or_one_of);
        if has_any_of_errors {
            // MTHDS-specific: try type-discriminated pipe validation first
            if let Some(mthds_errors) = self.validate_mthds_pipes(schema_url, root, &value) {
                if !mthds_errors.is_empty() {
                    // Replace AnyOf/OneOf with specific pipe errors
                    let kept: Vec<_> = node_errors
                        .into_iter()
                        .filter(|e| !e.is_any_of_or_one_of())
                        .collect();
                    node_errors = kept;
                    node_errors.extend(mthds_errors);
                    // Note: this early return means non-pipe AnyOf errors (e.g., in the
                    // concept section) won't get expanded in this pass. This is acceptable —
                    // the user fixes pipe errors first, then concept errors get expanded
                    // on the next lint run.
                    return Ok(node_errors);
                }
                // If mthds_errors is empty, all pipes are valid individually —
                // the error might be at a different level, fall through to generic path
            }

            // Generic path: expand AnyOf/OneOf via apply().basic()
            if let Some(validator) = self.get_validator(schema_url) {
                let output = validator.apply(&value).basic();
                if let BasicOutput::Invalid(units) = output {
                    let expanded = Self::expand_any_of_errors(&Keys::empty(), root, &units);
                    if !expanded.is_empty() {
                        // Replace AnyOf/OneOf errors with expanded leaf errors,
                        // keep non-AnyOf/OneOf errors from validate() unchanged
                        let kept: Vec<NodeValidationError> = node_errors
                            .into_iter()
                            .filter(|e| !e.is_any_of_or_one_of())
                            .collect();
                        node_errors = kept;
                        node_errors.extend(expanded);
                    }
                }
            }
        }

        Ok(node_errors)
    }

    /// Maximum leaf errors from the best-matching branch before we give up
    /// expanding and keep the original AnyOf/OneOf message.
    const MAX_LEAF_ERRORS: usize = 5;

    /// Expand AnyOf/OneOf errors using the "best matching branch" heuristic.
    ///
    /// Groups leaf errors by their oneOf/anyOf branch index, picks the branch
    /// with the fewest errors — that's the closest schema match.
    /// Only returns those errors if the count is small enough to be useful.
    /// Returns an empty Vec if expansion is not worthwhile (caller keeps originals).
    ///
    /// `base_keys` and `base_node` set the starting point for DOM walking.
    /// Pass `Keys::empty()` and root for top-level expansion, or pipe-specific
    /// keys/node for MTHDS per-pipe expansion.
    fn expand_any_of_errors(
        base_keys: &Keys,
        base_node: &dom::Node,
        units: &std::collections::VecDeque<OutputUnit<ErrorDescription>>,
    ) -> Vec<NodeValidationError> {
        use std::collections::{HashMap, HashSet};

        // Step 1: Group ALL non-trivial units by branch (before leaf filtering).
        // This ensures we don't lose track of branches whose errors are all intermediate.
        let mut raw_branches: HashMap<String, usize> = HashMap::new();
        let mut all_branched: Vec<(&OutputUnit<ErrorDescription>, Option<String>)> = Vec::new();

        for unit in units {
            let kw = unit.keyword_location().to_string();
            let msg = unit.error_description().to_string();

            // Skip completely empty or top-level combinator keyword locations
            if msg.is_empty() || kw.ends_with("/anyOf") || kw.ends_with("/oneOf") {
                continue;
            }

            let branch_key = Self::extract_branch_key(&kw);
            if let Some(ref key) = branch_key {
                *raw_branches.entry(key.clone()).or_insert(0) += 1;
            }
            all_branched.push((unit, branch_key));
        }

        // Step 2: Find branches with the fewest raw errors (best-matching).
        // Multiple branches may tie; we try each in sorted order and pick
        // the first one that yields actionable leaf errors.
        let min_count = raw_branches.values().min().copied();
        let Some(min_count) = min_count else {
            return Vec::new();
        };

        let mut candidate_branches: Vec<_> = raw_branches
            .iter()
            .filter(|(_, count)| **count == min_count)
            .map(|(key, _)| key.as_str())
            .collect();
        candidate_branches.sort_unstable(); // deterministic order

        for best_key in candidate_branches {
            // Step 3: Collect leaf errors from this branch, filtering
            // intermediate combinator messages, JSON dumps, and long messages.
            let best_candidates: Vec<_> = all_branched
                .iter()
                .filter(|(_, branch)| branch.as_deref() == Some(best_key))
                .map(|(unit, _)| *unit)
                .filter(|unit| {
                    let msg = unit.error_description().to_string();
                    msg.len() <= 200 && !Self::is_intermediate_combinator_message(&msg)
                })
                .collect();

            // If this branch has 0 actionable errors (all were intermediate
            // anyOf/oneOf through $ref) or too many, try the next branch.
            if best_candidates.is_empty() || best_candidates.len() > Self::MAX_LEAF_ERRORS {
                continue;
            }

            // Step 4: Deduplicate by (instance_location, message).
            let mut seen = HashSet::new();
            return best_candidates
                .iter()
                .filter(|unit| {
                    let key = (
                        unit.instance_location().to_string(),
                        unit.error_description().to_string(),
                    );
                    seen.insert(key)
                })
                .filter_map(|unit| {
                    NodeValidationError::from_apply_output_at(base_keys.clone(), base_node, unit)
                        .ok()
                })
                .collect();
        }

        Vec::new()
    }

    /// Detect intermediate anyOf/oneOf error messages by content pattern.
    ///
    /// `apply()` through `$ref` doesn't always put `/anyOf` or `/oneOf` at the
    /// end of `keyword_location`. These messages come from intermediate
    /// combinator nodes and are not useful leaf errors.
    fn is_intermediate_combinator_message(msg: &str) -> bool {
        msg.contains("is not valid under any of the schemas listed in the 'anyOf' keyword")
            || msg.contains("is not valid under any of the given schemas")
            || (msg.contains("is not of type") && msg.starts_with('{'))
    }

    /// Extract a branch key from a `keyword_location` string.
    /// Finds the last `oneOf/N` or `anyOf/N` segment pair.
    /// E.g., `/properties/pipe/anyOf/0/additionalProperties/oneOf/3/properties/type/enum`
    ///       → `"oneOf/3"`
    fn extract_branch_key(keyword_location: &str) -> Option<String> {
        let segments: Vec<&str> = keyword_location.split('/').collect();
        let mut last_branch = None;
        for window in segments.windows(2) {
            if (window[0] == "oneOf" || window[0] == "anyOf") && window[1].parse::<usize>().is_ok()
            {
                last_branch = Some(format!("{}/{}", window[0], window[1]));
            }
        }
        last_branch
    }

    #[tracing::instrument(skip_all, fields(%schema_url))]
    pub async fn validate(
        &self,
        schema_url: &Url,
        value: &Value,
    ) -> Result<Vec<ValidationError<'static>>, anyhow::Error> {
        let validator = match self.get_validator(schema_url) {
            Some(s) => s,
            None => {
                let schema = self
                    .load_schema(schema_url)
                    .await
                    .with_context(|| format!("failed to load schema {schema_url}"))?;
                self.add_schema(schema_url, schema.clone()).await;
                self.add_validator(schema_url.clone(), &schema)
                    .with_context(|| format!("invalid schema {schema_url}"))?
            }
        };

        self.validate_impl(&validator, value).await
    }

    async fn validate_impl(
        &self,
        validator: &JSONSchema,
        value: &Value,
    ) -> Result<Vec<ValidationError<'static>>, anyhow::Error> {
        // The following loop is required for retrieving external schemas.
        //
        // We don't know if any external schemas are required until we reach
        // a validation path that requires it, so we might have to loop many times
        // to fully validate according to a schema that has many nested references.
        loop {
            match validator.validate(value) {
                Ok(()) => return Ok(Vec::new()),
                Err(errors) => {
                    let errors: Vec<_> = errors
                        .map(|err| ValidationError {
                            instance: Cow::Owned(err.instance.into_owned()),
                            kind: err.kind,
                            instance_path: err.instance_path,
                            schema_path: err.schema_path,
                        })
                        .collect();

                    // We check whether there were any external schema errors,
                    // and retrieve the schemas accordingly.
                    let mut external_schema_requests: FuturesUnordered<_> = errors
                        .iter()
                        .filter_map(|err| {
                            if let ValidationErrorKind::Resolver { url, .. } = &err.kind {
                                Some(async {
                                    let value = self.load_schema(url).await?;
                                    drop(self.cache.store(url.clone(), value));
                                    Result::<(), anyhow::Error>::Ok(())
                                })
                            } else {
                                None
                            }
                        })
                        .collect();

                    // There are no external schemas to retrieve,
                    // return the errors as-is.
                    if external_schema_requests.is_empty() {
                        drop(external_schema_requests);
                        return Ok(errors);
                    }

                    // Retrieve external schemas, and return on the first failure.
                    while let Some(external_schema_result) = external_schema_requests.next().await {
                        external_schema_result?;
                    }

                    // Try validation again, now with external schemas
                    // resolved and cached.
                    continue;
                }
            };
        }
    }

    pub async fn add_schema(&self, schema_url: &Url, schema: Arc<Value>) {
        drop(self.cache.store(schema_url.clone(), schema).await);
    }

    #[tracing::instrument(skip_all, fields(%schema_url))]
    pub async fn load_schema(&self, schema_url: &Url) -> Result<Arc<Value>, anyhow::Error> {
        if let Ok(s) = self.cache.load(schema_url, false).await {
            tracing::debug!(%schema_url, "schema was found in cache");
            return Ok(s);
        }

        let schema = if let Some(builtin) = builtin_schema(schema_url) {
            builtin
        } else {
            match self.fetch_external(schema_url).await {
                Ok(s) => Arc::new(s),
                Err(error) => {
                    tracing::warn!(%error, "failed to fetch schema");
                    if let Ok(s) = self.cache.load(schema_url, true).await {
                        tracing::debug!(%schema_url, "expired schema was found in cache");
                        return Ok(s);
                    }
                    return Err(error);
                }
            }
        };

        if let Err(error) = self.cache.store(schema_url.clone(), schema.clone()).await {
            tracing::debug!(%error, "failed to cache schema");
        }

        Ok(schema)
    }

    /// Try loading a schema from an ordered list of URLs (waterfall).
    /// Returns the first successfully loaded schema and the URL it was loaded from.
    pub async fn load_schema_waterfall(
        &self,
        urls: &[&Url],
    ) -> Result<(Url, Arc<Value>), anyhow::Error> {
        let mut last_error = None;
        for url in urls {
            match self.load_schema(url).await {
                Ok(schema) => return Ok(((*url).clone(), schema)),
                Err(err) => {
                    tracing::debug!(%url, %err, "waterfall: source failed, trying next");
                    last_error = Some(err);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow!("no schema sources provided")))
    }

    /// Resolve the effective schema URL from an association (handles waterfall).
    /// Returns the URL of the first source that loads, plus the loaded schema.
    pub async fn resolve_association(
        &self,
        assoc: &associations::SchemaAssociation,
    ) -> Result<(Url, Arc<Value>), anyhow::Error> {
        let all = assoc.all_urls();
        self.load_schema_waterfall(&all).await
    }

    fn get_validator(&self, schema_url: &Url) -> Option<Arc<JSONSchema>> {
        if self.cache().lru_expired() {
            self.validators.lock().clear();
        }

        self.validators.lock().get(schema_url).cloned()
    }

    fn add_validator(
        &self,
        schema_url: Url,
        schema: &Value,
    ) -> Result<Arc<JSONSchema>, anyhow::Error> {
        let v = Arc::new(self.create_validator(schema)?);
        self.validators.lock().put(schema_url, v.clone());
        Ok(v)
    }

    #[async_recursion(?Send)]
    #[must_use]
    pub(crate) async fn resolve_schema(&self, url: Url) -> Result<Arc<Value>, anyhow::Error> {
        match url.fragment() {
            Some(fragment) => {
                let mut res_url = url.clone();
                res_url.set_fragment(None);
                let schema = self.resolve_schema(res_url).await?;
                let ptr = String::from("/") + fragment;
                schema
                    .pointer(&ptr)
                    .map(|v| Arc::new(v.clone()))
                    .ok_or_else(|| anyhow!("failed to resolve relative schema"))
            }
            None => {
                let val = self.load_schema(&url).await?;
                drop(self.cache.store(url, val.clone()));
                Ok(val)
            }
        }
    }

    fn create_validator(&self, schema: &Value) -> Result<JSONSchema, anyhow::Error> {
        JSONSchema::options()
            .with_resolver(CacheSchemaResolver {
                cache: self.cache().clone(),
            })
            .with_format("semver", formats::semver)
            .with_format("semver-requirement", formats::semver_req)
            .compile(schema)
            .map_err(|err| anyhow!("invalid schema: {err}"))
    }

    async fn fetch_external(&self, schema_url: &Url) -> Result<Value, anyhow::Error> {
        let _permit = self.concurrent_requests.acquire().await?;
        match schema_url.scheme() {
            "http" | "https" => Ok(self
                .http
                .get(schema_url.clone())
                .send()
                .await?
                .json()
                .await?),
            "file" => Ok(serde_json::from_slice(
                &self
                    .env
                    .read_file(
                        self.env
                            .to_file_path_normalized(schema_url)
                            .ok_or_else(|| anyhow!("invalid file path"))?
                            .as_ref(),
                    )
                    .await?,
            )?),
            scheme => Err(anyhow!("the scheme `{scheme}` is not supported")),
        }
    }
}

impl<E: Environment> Schemas<E> {
    #[tracing::instrument(skip_all, fields(%schema_url, %path))]
    pub async fn schemas_at_path(
        &self,
        schema_url: &Url,
        value: &Value,
        path: &Keys,
    ) -> Result<Vec<(Keys, Arc<Value>)>, anyhow::Error> {
        let mut schemas = Vec::new();
        let schema = self.load_schema(schema_url).await?;
        self.collect_schemas(
            schema_url,
            &schema,
            value,
            Keys::empty(),
            path,
            &mut schemas,
        )
        .await?;

        schemas = schemas
            .into_iter()
            .unique_by(|(k, s)| (k.clone(), ArcHashValue(s.clone())))
            .collect();

        Ok(schemas)
    }

    #[tracing::instrument(skip_all, fields(%path))]
    #[async_recursion(?Send)]
    #[must_use]
    async fn collect_schemas(
        &self,
        root_url: &Url,
        schema: &Value,
        value: &Value,
        full_path: Keys,
        path: &Keys,
        schemas: &mut Vec<(Keys, Arc<Value>)>,
    ) -> Result<(), anyhow::Error> {
        if !schema.is_object() {
            return Ok(());
        }

        if let Some(r) = schema.schema_ref() {
            let url = reference_url(root_url, r)
                .ok_or_else(|| anyhow!("could not determine schema URL"))?;
            let schema = self.resolve_schema(url).await?;
            return self
                .collect_schemas(root_url, &schema, value, full_path.clone(), path, schemas)
                .await;
        }

        if let Some(one_ofs) = schema["oneOf"].as_array() {
            for one_of in one_ofs {
                self.collect_schemas(root_url, one_of, value, full_path.clone(), path, schemas)
                    .await?;
            }
        }

        if let Some(any_ofs) = schema["anyOf"].as_array() {
            for any_of in any_ofs {
                self.collect_schemas(root_url, any_of, value, full_path.clone(), path, schemas)
                    .await?;
            }
        }

        if let Some(all_ofs) = schema["allOf"].as_array() {
            for all_of in all_ofs {
                self.collect_schemas(root_url, all_of, value, full_path.clone(), path, schemas)
                    .await?;
            }
        }

        let include_self = schema["allOf"].is_null();

        let Some(key) = path.iter().next() else {
            if include_self {
                schemas.push((full_path.clone(), Arc::new(schema.clone())));
            }
            return Ok(());
        };

        let child_path = path.skip_left(1);

        match key {
            KeyOrIndex::Key(k) => {
                // For array of tables.
                self.collect_schemas(
                    root_url,
                    &schema["items"][k.value()],
                    value,
                    full_path.join(k.clone()),
                    &child_path,
                    schemas,
                )
                .await?;

                self.collect_schemas(
                    root_url,
                    &schema["properties"][k.value()],
                    &value[k.value()],
                    full_path.join(k.clone()),
                    &child_path,
                    schemas,
                )
                .await?;

                self.collect_schemas(
                    root_url,
                    &schema["additionalProperties"],
                    &value[k.value()],
                    full_path.join(k.clone()),
                    &child_path,
                    schemas,
                )
                .await?;

                if let Some(pattern_props) = schema["patternProperties"].as_object() {
                    for (pattern, pattern_schema) in pattern_props {
                        if let Ok(re) = Regex::new(pattern) {
                            if re.is_match(k.value()) {
                                self.collect_schemas(
                                    root_url,
                                    pattern_schema,
                                    &value[k.value()],
                                    full_path.join(k.clone()),
                                    &child_path,
                                    schemas,
                                )
                                .await?;
                            }
                        }
                    }
                }
            }
            KeyOrIndex::Index(idx) => {
                if schema["items"].is_array() {
                    self.collect_schemas(
                        root_url,
                        &schema["items"][idx],
                        &value[idx],
                        full_path.join(*idx),
                        &child_path,
                        schemas,
                    )
                    .await?;
                } else {
                    self.collect_schemas(
                        root_url,
                        &schema["items"],
                        &value[idx],
                        full_path.join(*idx),
                        &child_path,
                        schemas,
                    )
                    .await?;
                }
            }
        }

        Ok(())
    }

    #[tracing::instrument(skip_all, fields(%schema_url, %path))]
    pub async fn possible_schemas_from(
        &self,
        schema_url: &Url,
        value: &Value,
        path: &Keys,
        max_depth: usize,
    ) -> Result<Vec<(Keys, Keys, Arc<Value>)>, anyhow::Error> {
        let schemas = self.schemas_at_path(schema_url, value, path).await?;

        let mut children = Vec::with_capacity(schemas.len());

        for (path, schema) in schemas {
            self.collect_child_schemas(
                schema_url,
                &schema,
                &path,
                &Keys::empty(),
                max_depth,
                &mut children,
            )
            .await;
        }

        children = children
            .into_iter()
            .unique_by(|(k1, k2, s)| (k1.clone(), k2.clone(), ArcHashValue(s.clone())))
            .collect();

        Ok(children)
    }

    #[async_recursion(?Send)]
    #[must_use]
    #[allow(clippy::too_many_arguments)]
    async fn collect_child_schemas(
        &self,
        root_url: &Url,
        schema: &Value,
        root_path: &Keys,
        path: &Keys,
        mut depth: usize,
        schemas: &mut Vec<(Keys, Keys, Arc<Value>)>,
    ) {
        if !schema.is_object() || depth == 0 {
            return;
        }

        if let Some(schema) = self.ref_schema_value(root_url, schema).await {
            return self
                .collect_child_schemas(root_url, &schema, root_path, path, depth, schemas)
                .await;
        }

        if let Some(one_ofs) = schema["oneOf"].as_array() {
            for one_of in one_ofs {
                self.collect_child_schemas(root_url, one_of, root_path, path, depth, schemas)
                    .await;
            }
        }

        if let Some(any_ofs) = schema["anyOf"].as_array() {
            for any_of in any_ofs {
                self.collect_child_schemas(root_url, any_of, root_path, path, depth, schemas)
                    .await;
            }
        }

        // Deal with the { "description": "Foo", "allOf": [{ "$ref": "Bar" }] }
        // pattern.
        let composed = [
            !schema["allOf"].is_null(),
            !schema["oneOf"].is_null(),
            !schema["anyOf"].is_null(),
        ]
        .into_iter()
        .filter(|b| *b)
        .count()
            == 1
            && schema["properties"].is_null();

        if let Some(all_ofs) = schema["allOf"].as_array() {
            if !all_ofs.is_empty() && composed {
                let mut schema = schema.clone();
                if let Some(obj) = schema["allOf"].as_object_mut() {
                    obj.remove("allOf");
                }

                let mut merged_all_of = Value::Object(serde_json::Map::default());

                for all_of in all_ofs {
                    merged_all_of.merge(match self.ref_schema_value(root_url, all_of).await {
                        Some(ref schema) => schema,
                        None => all_of,
                    });
                }

                merged_all_of.merge(&schema);

                self.collect_child_schemas(
                    root_url,
                    &merged_all_of,
                    root_path,
                    path,
                    depth,
                    schemas,
                )
                .await;
            }
            // TODO: handle allOfs in regular schemas.
            // doing so currently will overflow the stack.
        }

        let include_self = !composed;

        if include_self {
            schemas.push((
                root_path.extend(path.clone()),
                path.clone(),
                Arc::new(schema.clone()),
            ));
        }

        depth -= 1;

        if let Some(map) = schema["properties"].as_object() {
            for (k, v) in map {
                self.collect_child_schemas(
                    root_url,
                    v,
                    root_path,
                    &path.join(Key::from(k)),
                    depth,
                    schemas,
                )
                .await;
            }
        }
    }

    async fn ref_schema_value(&self, root_url: &Url, schema: &Value) -> Option<Arc<Value>> {
        if let Some(r) = schema.schema_ref() {
            let url = match reference_url(root_url, r)
                .ok_or_else(|| anyhow!("could not determine schema URL"))
            {
                Ok(u) => u,
                Err(error) => {
                    tracing::error!(?error, "failed to resolve schema");
                    return None;
                }
            };
            let schema = match self.resolve_schema(url).await {
                Ok(s) => s,
                Err(error) => {
                    tracing::error!(?error, "failed to resolve schema");
                    return None;
                }
            };

            Some(schema)
        } else {
            None
        }
    }
}

fn reference_url(root_url: &Url, reference: &str) -> Option<Url> {
    if !reference.starts_with('#') {
        return Url::parse(reference).ok();
    }
    let mut url = root_url.clone();
    url.set_fragment(Some(reference.trim_start_matches("#/")));
    Some(url)
}

pub trait ValueExt {
    fn is_schema_ref(&self) -> bool;
    fn schema_ref(&self) -> Option<&str>;
}

impl ValueExt for Value {
    fn is_schema_ref(&self) -> bool {
        self["$ref"].is_string()
    }

    fn schema_ref(&self) -> Option<&str> {
        self["$ref"].as_str()
    }
}

struct CacheSchemaResolver<E: Environment> {
    cache: Cache<E>,
}

impl<E: Environment> SchemaResolver for CacheSchemaResolver<E> {
    fn resolve(
        &self,
        _root_schema: &serde_json::Value,
        url: &Url,
        _original_ref: &str,
    ) -> Result<Arc<serde_json::Value>, jsonschema::SchemaResolverError> {
        self.cache
            .get_schema(url)
            .ok_or_else(|| WouldBlockError.into())
    }
}

#[derive(Debug, Error)]
#[error("retrieving the schema requires external operations")]
struct WouldBlockError;

/// Source of a validation error — either from `validate()` or from `apply().basic()`.
#[derive(Debug)]
enum ErrorSource {
    /// From `validate()` — has full error kind for `AdditionalProperties` handling, etc.
    Validation(ValidationError<'static>),
    /// From `apply().basic()` — pre-formatted message, `keyword_location` for kind detection.
    Applied {
        message: String,
        keyword_location: String,
    },
}

/// A validation error that contains text ranges as well.
#[derive(Debug)]
pub struct NodeValidationError {
    pub keys: Keys,
    pub node: dom::Node,
    source: ErrorSource,
    /// Dotted path to the error location in the document,
    /// e.g. `pipe.generate_infographic.model`. Computed at construction
    /// from base keys + instance path, before error-specific keys are mixed in.
    error_location: String,
}

impl NodeValidationError {
    /// Walk the DOM following `instance_path` segments from a starting position.
    /// Returns the final (keys, node) after walking.
    fn walk_instance_path(
        mut keys: Keys,
        mut node: dom::Node,
        instance_path: &jsonschema::paths::JSONPointer,
    ) -> Result<(Keys, dom::Node), anyhow::Error> {
        'outer: for path in instance_path {
            match path {
                PathChunk::Property(p) => match node {
                    dom::Node::Table(t) => {
                        let entries = t.entries().read();
                        for (k, entry) in entries.iter() {
                            if k.value() == &**p {
                                keys = keys.join(k.clone());
                                node = entry.clone();
                                continue 'outer;
                            }
                        }
                        return Err(anyhow!("invalid key"));
                    }
                    _ => return Err(anyhow!("invalid key")),
                },
                PathChunk::Index(idx) => {
                    node = node.try_get(*idx).map_err(|_| anyhow!("invalid index"))?;
                    keys = keys.join(*idx);
                }
                PathChunk::Keyword(_) => {}
            }
        }
        Ok((keys, node))
    }

    /// Walk the DOM following `instance_location` segments from an apply output unit.
    /// Returns the final (keys, node) after walking.
    fn walk_apply_location(
        mut keys: Keys,
        mut node: dom::Node,
        unit: &OutputUnit<ErrorDescription>,
    ) -> Result<(Keys, dom::Node), anyhow::Error> {
        let keyword_location = unit.keyword_location().to_string();
        let message = unit.error_description().to_string();

        // Check if this is an additionalProperties error — extract unexpected keys from message
        let is_additional_props = keyword_location.ends_with("/additionalProperties");
        if is_additional_props {
            // Message format: "Additional properties are not allowed ('foo' was unexpected)"
            // or: "Additional properties are not allowed ('foo', 'bar' were unexpected)"
            if let Some(start) = message.find('\'') {
                let rest = &message[start..];
                for part in rest.split('\'') {
                    let trimmed = part.trim();
                    if !trimmed.is_empty()
                        && trimmed != ","
                        && !trimmed.starts_with("was ")
                        && !trimmed.starts_with("were ")
                    {
                        keys = keys.join(Key::from(trimmed));
                    }
                }
            }
        }

        'outer: for chunk in unit.instance_location() {
            match chunk {
                PathChunk::Property(p) => match node {
                    dom::Node::Table(t) => {
                        let entries = t.entries().read();
                        for (k, entry) in entries.iter() {
                            if k.value() == &**p {
                                keys = keys.join(k.clone());
                                node = entry.clone();
                                continue 'outer;
                            }
                        }
                        return Err(anyhow!("invalid key in apply output"));
                    }
                    _ => return Err(anyhow!("expected table in apply output")),
                },
                PathChunk::Index(idx) => {
                    node = node
                        .try_get(*idx)
                        .map_err(|_| anyhow!("invalid index in apply output"))?;
                    keys = keys.join(*idx);
                }
                PathChunk::Keyword(_) => {}
            }
        }
        Ok((keys, node))
    }

    /// Build from a `validate()` error, walking the DOM from root.
    fn new(root: &dom::Node, error: ValidationError<'static>) -> Result<Self, anyhow::Error> {
        Self::new_from(Keys::empty(), root, error)
    }

    /// Build from a `validate()` error, walking the DOM from a base node.
    /// Prepends `base_keys` so text ranges point to the correct location in the full document.
    fn new_from(
        mut keys: Keys,
        base_node: &dom::Node,
        error: ValidationError<'static>,
    ) -> Result<Self, anyhow::Error> {
        // Compute the clean instance location BEFORE mixing in error-specific keys.
        // base_keys (e.g. "pipe.foo") + instance_path (e.g. "/model") → "pipe.foo.model"
        let error_location = Self::build_location(&keys, &error.instance_path);

        if let ValidationErrorKind::AdditionalProperties { unexpected } = &error.kind {
            keys = keys.extend(unexpected.iter().map(Key::from).map(KeyOrIndex::Key));
        }

        let (keys, node) = Self::walk_instance_path(keys, base_node.clone(), &error.instance_path)?;

        Ok(Self {
            keys,
            node,
            source: ErrorSource::Validation(error),
            error_location,
        })
    }

    /// Build from an `apply().basic()` output unit, walking from a base node.
    /// Prepends `base_keys` so text ranges point to the correct location in the full document.
    fn from_apply_output_at(
        keys: Keys,
        base_node: &dom::Node,
        unit: &OutputUnit<ErrorDescription>,
    ) -> Result<Self, anyhow::Error> {
        let keyword_location = unit.keyword_location().to_string();
        let instance_location = unit.instance_location().to_string();
        let message = unit.error_description().to_string();

        // Compute location: base_keys dotted + instance_location segments
        let base_dotted = keys.dotted().to_string();
        let inst_dotted = instance_location.trim_start_matches('/').replace('/', ".");
        let error_location = match (base_dotted.is_empty(), inst_dotted.is_empty()) {
            (true, true) => String::new(),
            (true, false) => inst_dotted,
            (false, true) => base_dotted,
            (false, false) => format!("{base_dotted}.{inst_dotted}"),
        };

        let (keys, node) = Self::walk_apply_location(keys, base_node.clone(), unit)?;

        Ok(Self {
            keys,
            node,
            source: ErrorSource::Applied {
                message,
                keyword_location,
            },
            error_location,
        })
    }

    /// Whether this error is an AnyOf/OneOf from `validate()`.
    fn is_any_of_or_one_of(&self) -> bool {
        matches!(
            &self.source,
            ErrorSource::Validation(e) if matches!(
                e.kind,
                ValidationErrorKind::AnyOf | ValidationErrorKind::OneOfNotValid
            )
        )
    }

    #[must_use]
    pub fn text_ranges(&self) -> Box<dyn Iterator<Item = TextRange> + '_> {
        let is_additional_props = match &self.source {
            ErrorSource::Validation(e) => {
                matches!(e.kind, ValidationErrorKind::AdditionalProperties { .. })
            }
            ErrorSource::Applied {
                keyword_location, ..
            } => keyword_location.ends_with("/additionalProperties"),
        };

        if is_additional_props {
            let include_children = false;

            if self.keys.is_empty() {
                return Box::new(self.node.text_ranges(include_children));
            }

            Box::new(
                self.keys
                    .clone()
                    .into_iter()
                    .flat_map(move |key| self.node.get(key).text_ranges(include_children)),
            )
        } else {
            Box::new(self.node.text_ranges(true))
        }
    }

    /// Format a human-readable error message.
    ///
    /// The default `ValidationError::Display` dumps the full JSON instance,
    /// which can be thousands of characters for `AnyOf`/`OneOf` errors.
    /// This method produces concise messages suitable for diagnostics.
    #[must_use]
    pub fn display_message(&self) -> String {
        match &self.source {
            ErrorSource::Applied {
                message,
                keyword_location,
                ..
            } => {
                // Applied AnyOf/OneOf errors dump the full JSON instance — replace
                // with a concise path-based message, same as we do for Validation errors.
                if keyword_location.ends_with("/anyOf") || keyword_location.ends_with("/oneOf") {
                    return self.concise_schema_mismatch_message();
                }
                // For other Applied errors, truncate if the message embeds a large JSON instance.
                if message.len() <= 200 {
                    return message.clone();
                }
                Self::truncate_json_in_message(message)
            }
            ErrorSource::Validation(error) => match &error.kind {
                // AnyOf/OneOf dump the entire instance — replace with path-based message.
                ValidationErrorKind::AnyOf | ValidationErrorKind::OneOfNotValid => {
                    self.concise_schema_mismatch_message()
                }
                // All other errors: use default Display but truncate if instance is huge.
                _ => {
                    let msg = error.to_string();
                    if msg.len() <= 200 {
                        return msg;
                    }
                    let instance_str = error.instance.to_string();
                    if instance_str.len() <= 120 {
                        return msg;
                    }
                    let truncated = &instance_str[..80.min(instance_str.len())];
                    let replacement =
                        format!("{}... ({} more chars)", truncated, instance_str.len() - 80);
                    msg.replacen(&instance_str, &replacement, 1)
                }
            },
        }
    }

    /// Concise message for AnyOf/OneOf schema mismatch errors.
    fn concise_schema_mismatch_message(&self) -> String {
        if self.keys.is_empty() {
            "value does not match any of the allowed schemas".to_string()
        } else {
            format!("'{}' does not match any of the allowed schemas", self.keys)
        }
    }

    /// Truncate a message that embeds a large JSON instance.
    fn truncate_json_in_message(message: &str) -> String {
        // Try to find a JSON object/array in the message and truncate it
        if let Some(json_start) = message.find('{').or_else(|| message.find('[')) {
            let before = &message[..json_start];
            let json_part = &message[json_start..];
            if json_part.len() > 120 {
                // Find a char boundary at or before byte 80 to avoid slicing mid-char
                let truncate_at = json_part
                    .char_indices()
                    .take_while(|(i, _)| *i < 80)
                    .last()
                    .map_or(0, |(i, c)| i + c.len_utf8());
                let truncated = &json_part[..truncate_at];
                return format!(
                    "{}{}... ({} more chars)",
                    before,
                    truncated,
                    json_part.chars().count() - truncated.chars().count()
                );
            }
        }
        message.to_string()
    }

    /// Return the dotted instance path where this error occurred,
    /// e.g. `pipe.generate_infographic.model` for an error inside a pipe's model field.
    /// Returns `None` if the error is at the document root.
    #[must_use]
    pub fn instance_location(&self) -> Option<String> {
        if self.error_location.is_empty() {
            None
        } else {
            Some(self.error_location.clone())
        }
    }

    /// Build a dotted location string from base keys + a JSON pointer instance path.
    fn build_location(base_keys: &Keys, instance_path: &jsonschema::paths::JSONPointer) -> String {
        let base = base_keys.dotted();
        let path_str = instance_path.to_string();
        let inst = path_str.trim_start_matches('/').replace('/', ".");
        match (base.is_empty(), inst.is_empty()) {
            (true, true) => String::new(),
            (true, false) => inst,
            (false, true) => base.to_string(),
            (false, false) => format!("{base}.{inst}"),
        }
    }

    /// Return the most specific (narrowest) text range for this error.
    /// Picks the last range, which is typically the most specific.
    #[must_use]
    pub fn primary_text_range(&self) -> Option<TextRange> {
        self.text_ranges().last()
    }
}

mod formats {
    pub(super) fn semver(value: &str) -> bool {
        semver::Version::parse(value).is_ok()
    }

    pub(super) fn semver_req(value: &str) -> bool {
        semver::VersionReq::parse(value).is_ok()
    }
}

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
mod tests {
    use super::associations::SchemaAssociation;
    use crate::environment::Environment;
    use async_trait::async_trait;
    use serde_json::json;
    use std::path::{Path, PathBuf};
    use time::OffsetDateTime;
    use url::Url;

    /// Minimal mock environment that controls which file:// paths "exist".
    #[derive(Clone)]
    struct MockEnv {
        /// Map from file path -> file contents (as JSON bytes).
        files: std::collections::HashMap<PathBuf, Vec<u8>>,
    }

    #[async_trait(?Send)]
    impl Environment for MockEnv {
        type Stdin = tokio::io::Empty;
        type Stdout = tokio::io::Sink;
        type Stderr = tokio::io::Sink;

        fn now(&self) -> OffsetDateTime {
            OffsetDateTime::now_utc()
        }
        fn spawn<F>(&self, _fut: F)
        where
            F: futures::Future + Send + 'static,
            F::Output: Send,
        {
        }
        fn spawn_local<F>(&self, _fut: F)
        where
            F: futures::Future + 'static,
        {
        }
        fn env_var(&self, _name: &str) -> Option<String> {
            None
        }
        fn env_vars(&self) -> Vec<(String, String)> {
            vec![]
        }
        fn atty_stderr(&self) -> bool {
            false
        }
        fn stdin(&self) -> Self::Stdin {
            tokio::io::empty()
        }
        fn stdout(&self) -> Self::Stdout {
            tokio::io::sink()
        }
        fn stderr(&self) -> Self::Stderr {
            tokio::io::sink()
        }
        fn glob_files(&self, _glob: &str) -> Result<Vec<PathBuf>, anyhow::Error> {
            Ok(vec![])
        }
        async fn read_file(&self, path: &Path) -> Result<Vec<u8>, anyhow::Error> {
            self.files
                .get(path)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("file not found: {}", path.display()))
        }
        async fn write_file(&self, _path: &Path, _bytes: &[u8]) -> Result<(), anyhow::Error> {
            Ok(())
        }
        fn to_file_path(&self, url: &Url) -> Option<PathBuf> {
            url.to_file_path().ok()
        }
        fn is_absolute(&self, path: &Path) -> bool {
            path.is_absolute()
        }
        fn cwd(&self) -> Option<PathBuf> {
            Some(PathBuf::from("/"))
        }
        async fn find_config_file(&self, _from: &Path) -> Option<PathBuf> {
            None
        }
    }

    fn minimal_schema_json() -> Vec<u8> {
        serde_json::to_vec(&json!({"type": "object"})).unwrap()
    }

    #[test]
    fn embedded_mthds_schema_parses_as_valid_json() {
        let schema = super::builtins::mthds_schema();
        assert!(schema.is_object(), "MTHDS schema should be a JSON object");
        // Verify it has expected top-level keys
        assert!(
            schema.get("type").is_some() || schema.get("$schema").is_some(),
            "MTHDS schema should have a 'type' or '$schema' key"
        );
    }

    #[tokio::test]
    async fn resolve_association_single_url_success() {
        let mut files = std::collections::HashMap::new();
        files.insert(PathBuf::from("/schemas/good.json"), minimal_schema_json());
        let env = MockEnv { files };
        let http = reqwest::Client::new();
        let schemas = super::Schemas::new(env, http);

        let assoc = SchemaAssociation {
            url: "file:///schemas/good.json".parse().unwrap(),
            meta: json!({}),
            priority: 50,
            fallback_urls: vec![],
        };

        let (resolved_url, _schema) = schemas.resolve_association(&assoc).await.unwrap();
        assert_eq!(resolved_url.as_str(), "file:///schemas/good.json");
    }

    #[tokio::test]
    async fn resolve_association_single_url_failure() {
        let env = MockEnv {
            files: std::collections::HashMap::new(),
        };
        let http = reqwest::Client::new();
        let schemas = super::Schemas::new(env, http);

        let assoc = SchemaAssociation {
            url: "file:///schemas/missing.json".parse().unwrap(),
            meta: json!({}),
            priority: 50,
            fallback_urls: vec![],
        };

        assert!(schemas.resolve_association(&assoc).await.is_err());
    }

    #[tokio::test]
    async fn resolve_association_waterfall_first_fails_second_succeeds() {
        let mut files = std::collections::HashMap::new();
        // First source doesn't exist, second does.
        files.insert(
            PathBuf::from("/schemas/fallback.json"),
            minimal_schema_json(),
        );
        let env = MockEnv { files };
        let http = reqwest::Client::new();
        let schemas = super::Schemas::new(env, http);

        let assoc = SchemaAssociation {
            url: "file:///schemas/missing.json".parse().unwrap(),
            meta: json!({}),
            priority: 50,
            fallback_urls: vec!["file:///schemas/fallback.json".parse().unwrap()],
        };

        let (resolved_url, _schema) = schemas.resolve_association(&assoc).await.unwrap();
        assert_eq!(resolved_url.as_str(), "file:///schemas/fallback.json");
    }

    #[tokio::test]
    async fn resolve_association_waterfall_first_succeeds() {
        let mut files = std::collections::HashMap::new();
        files.insert(PathBuf::from("/schemas/first.json"), minimal_schema_json());
        files.insert(PathBuf::from("/schemas/second.json"), minimal_schema_json());
        let env = MockEnv { files };
        let http = reqwest::Client::new();
        let schemas = super::Schemas::new(env, http);

        let assoc = SchemaAssociation {
            url: "file:///schemas/first.json".parse().unwrap(),
            meta: json!({}),
            priority: 50,
            fallback_urls: vec!["file:///schemas/second.json".parse().unwrap()],
        };

        let (resolved_url, _schema) = schemas.resolve_association(&assoc).await.unwrap();
        // Should pick the first one since it exists.
        assert_eq!(resolved_url.as_str(), "file:///schemas/first.json");
    }

    #[tokio::test]
    async fn resolve_association_waterfall_all_fail() {
        let env = MockEnv {
            files: std::collections::HashMap::new(),
        };
        let http = reqwest::Client::new();
        let schemas = super::Schemas::new(env, http);

        let assoc = SchemaAssociation {
            url: "file:///schemas/a.json".parse().unwrap(),
            meta: json!({}),
            priority: 50,
            fallback_urls: vec![
                "file:///schemas/b.json".parse().unwrap(),
                "file:///schemas/c.json".parse().unwrap(),
            ],
        };

        assert!(schemas.resolve_association(&assoc).await.is_err());
    }

    /// Test that validates the bundle.mthds file from pipelex-demo and prints
    /// exactly what the extension will display in the Problems panel.
    #[tokio::test]
    async fn mthds_pipe_validation_shows_specific_errors() {
        let env = MockEnv {
            files: std::collections::HashMap::new(),
        };
        let http = reqwest::Client::new();
        let schemas = super::Schemas::new(env, http);

        // The actual bundle.mthds content from pipelex-demo
        let mthds_content = r#"
domain      = "ai_news"
description = "Search for AI Agent news, summarize the top 3, and generate an infographic"
main_pipe   = "create_news_infographic"

[concept.NewsSummary]
description = "A concise summary of the top 3 AI Agent news stories"
refines     = "Text"

[pipe.create_news_infographic]
type = "PipeSequence"
description = "Search for AI Agent news, summarize top 3, and generate an infographic"
inputs = { topic = "Text" }
output = "Image"
steps = [
  { pipe = "search_ai_agent_news", result = "search_results" },
  { pipe = "summarize_top_news", result = "news_summary" },
  { pipe = "craft_infographic_prompt", result = "img_prompt" },
  { pipe = "generate_infographic", result = "infographic" },
]

[pipe.search_ai_agent_news]
type        = "PipeSearch"
description = "Search the web for the latest AI Agents news from the past week"
inputs      = { topic = "Text" }
output      = "SearchResult"
model       = "$standard"
prompt      = "What are the biggest news and developments about AI Agents in the last week?"
from_date   = "2026-02-26"

[pipe.summarize_top_news]
type = "PipeLLM"
description = "Summarize the 3 biggest AI Agent news from search results"
inputs = { search_results = "SearchResult" }
output = "NewsSummary"
model = "$writing-creative"
prompt = """
Based on these search results about AI Agents news:

@search_results

Write a concise summary.
"""

[pipe.craft_infographic_prompt]
type = "PipeLLM"
description = "Create an image generation prompt for an infographic of the news summary"
inputs = { news_summary = "NewsSummary" }
output = "ImgGenPrompt"
model = "$img-gen-prompting"
prompt = """
You are an expert visual designer. Based on this news summary about AI Agents:

@news_summary

Create a detailed image generation prompt.
"""

[pipe.generate_infographic]
type        = "PipeImgGen"
description = "Generate the infographic image using Nano Banana 2"
inputs      = { img_prompt = "ImgGenPrompt" }
output      = "Image"
model       = { model = "nano-banana-pro", aspect_ratio = "landscape_16_9" }
prompt      = "$img_prompt"
"#;

        let parsed = taplo::parser::parse(mthds_content);
        let dom = parsed.into_dom();

        let schema_url: Url = super::builtins::MTHDS_SCHEMA_URL.parse().unwrap();

        // Pre-load the MTHDS schema into the cache
        let mthds_schema = super::builtins::mthds_schema();
        schemas.add_schema(&schema_url, mthds_schema).await;

        let errors = schemas.validate_root(&schema_url, &dom).await.unwrap();

        // The key assertion: we should NOT see the generic "does not match any"
        // message. Instead we should see specific errors about `aspect_ratio`.
        let messages: Vec<String> = errors
            .iter()
            .map(super::NodeValidationError::display_message)
            .collect();

        assert!(
            !messages
                .iter()
                .any(|m| m.contains("does not match any of the allowed schemas")),
            "Should NOT see generic 'does not match' — got: {messages:?}",
        );
        assert!(
            messages.iter().any(|m| m.contains("aspect_ratio")),
            "Should see specific error about 'aspect_ratio' — got: {messages:?}",
        );
    }
}
