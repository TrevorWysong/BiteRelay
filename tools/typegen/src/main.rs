//! Generates `web/src/holochain/generated.ts` -- the TypeScript mirror of the
//! Rust types that cross the app websocket -- straight from the Rust source,
//! so the two can't drift.
//!
//! It reads each listed source file with `syn` and emits TS following
//! serde's default (externally tagged) representation, which is what
//! Holochain's msgpack encoding produces:
//!
//! - a struct with named fields -> an interface;
//! - an enum of unit variants -> a union of string literals;
//! - any other enum -> a union of `{ Variant: payload }` objects (unit
//!   variants stay bare strings).
//!
//! Holochain's hash and timestamp types map to the aliases at the top of the
//! output. A referenced type that's neither generated nor aliased is an
//! error, naming the type -- add its source file below.
//!
//! Usage (from the repo root): `cargo run --manifest-path tools/typegen/Cargo.toml`
//! writes the file; `-- --check` exits non-zero if it's out of date (CI).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::{env, fs, process};
use syn::{Attribute, Fields, GenericArgument, Item, PathArguments, Type};

const OUTPUT: &str = "web/src/holochain/generated.ts";

/// Where the wire types live. `None` takes every serde type in the file;
/// `Some` takes just the named ones (for files that also hold internal
/// types). A rename resolves two files defining the same name.
struct Source {
    path: &'static str,
    only: Option<&'static [&'static str]>,
    rename: &'static [(&'static str, &'static str)],
}

const fn all(path: &'static str) -> Source {
    Source { path, only: None, rename: &[] }
}
const fn only(path: &'static str, names: &'static [&'static str]) -> Source {
    Source { path, only: Some(names), rename: &[] }
}

const SOURCES: &[Source] = &[
    all("dnas/relay/types/src/lib.rs"),
    all("dnas/relay/zomes/attestation/types/src/lib.rs"),
    all("dnas/relay/zomes/catalog/types/src/lib.rs"),
    only("dnas/relay/zomes/catalog/types/src/hours.rs", &["OpeningPeriod"]),
    all("dnas/relay/zomes/dispatch/types/src/lib.rs"),
    all("dnas/relay/zomes/dispatch/types/src/settlement.rs"),
    all("dnas/relay/zomes/dispute/types/src/lib.rs"),
    only("dnas/relay/zomes/profiles/integrity/src/lib.rs", &["RoleTag", "Profile", "ProviderCredential", "SavedAddress", "AddressDetails"]),
    only("dnas/relay/zomes/reputation/integrity/src/lib.rs", &["ReputationTarget", "ReviewTarget", "Review", "ItemReview", "ReputationEventKind"]),
    only("dnas/relay/zomes/dispatch/integrity/src/recurring.rs", &["RecurrenceRule", "RecurringOrderTemplate", "TemplateDetails"]),
    only("dnas/relay/zomes/geo_presence/integrity/src/lib.rs", &["PresenceBeacon"]),
    only("dnas/relay/zomes/ledger/types/src/lib.rs", &["TxnReason", "LedgerTransaction"]),
    only("dnas/relay/zomes/dispatch/coordinator/src/bids.rs", &["WarrantSummary"]),
    only("dnas/relay/zomes/dispatch/coordinator/src/receipts.rs", &["Receipt", "ReceiptLine", "ReceiptPayment"]),
    only("dnas/relay/zomes/reputation/coordinator/src/lib.rs", &["ReputationSummary", "RatingSummary"]),
    only("dnas/relay/zomes/geo_presence/coordinator/src/lib.rs", &["NearbyProvider"]),
    Source { path: "dnas/relay/zomes/dispatch/coordinator/src/signals.rs", only: Some(&["LocalSignal", "OrderChange", "OrderRole"]), rename: &[("LocalSignal", "DispatchLocalSignal")] },
    Source { path: "dnas/relay/zomes/catalog/coordinator/src/signals.rs", only: Some(&["LocalSignal"]), rename: &[("LocalSignal", "CatalogLocalSignal")] },
];

/// Holochain types, emitted once as aliases at the top of the output.
const ALIASES: &[(&str, &str, &str)] = &[
    ("ActionHash", "Uint8Array", "A 39-byte action hash."),
    ("EntryHash", "Uint8Array", "A 39-byte entry hash."),
    ("AgentPubKey", "Uint8Array", "A 39-byte agent public key."),
    ("AnyLinkableHash", "Uint8Array", "Any hash a link can point at."),
    ("Timestamp", "number", "Microseconds since the Unix epoch."),
    (
        "XSalsa20Poly1305EncryptedData",
        "{ nonce: Uint8Array; encrypted_data: Uint8Array }",
        "Ciphertext sealed between two agents -- opened only through a zome call.",
    ),
];

fn main() {
    let check = env::args().any(|arg| arg == "--check");
    let root = repo_root();
    let output = match generate(&root) {
        Ok(output) => output,
        Err(message) => {
            eprintln!("typegen: {message}");
            process::exit(1);
        }
    };
    let out_path = root.join(OUTPUT);
    if check {
        if fs::read_to_string(&out_path).ok().as_deref() != Some(output.as_str()) {
            eprintln!("typegen: {OUTPUT} is out of date -- run `npm run typegen` in web/");
            process::exit(1);
        }
        return;
    }
    fs::write(&out_path, output).unwrap_or_else(|e| panic!("writing {}: {e}", out_path.display()));
    println!("typegen: wrote {OUTPUT}");
}

/// The repo root: this crate lives at `tools/typegen`.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repo root")
}

/// One emitted declaration, keyed by its TS name.
struct Decl {
    docs: Vec<String>,
    body: String,
    referenced: BTreeSet<String>,
    source: &'static str,
}

fn generate(root: &Path) -> Result<String, String> {
    let mut decls: BTreeMap<String, Decl> = BTreeMap::new();
    for source in SOURCES {
        let text = fs::read_to_string(root.join(source.path)).map_err(|e| format!("reading {}: {e}", source.path))?;
        let file = syn::parse_file(&text).map_err(|e| format!("parsing {}: {e}", source.path))?;
        let mut found = BTreeSet::new();
        for item in &file.items {
            let Some((rust_name, docs, attrs_ok)) = item_header(item) else { continue };
            let wanted = match source.only {
                Some(names) => names.contains(&rust_name.as_str()),
                None => attrs_ok,
            };
            if !wanted {
                continue;
            }
            found.insert(rust_name.clone());
            let ts_name = rename(source, &rust_name);
            let mut referenced = BTreeSet::new();
            let body = emit_item(item, &ts_name, source, &mut referenced)?;
            if let Some(existing) = decls.get(&ts_name) {
                return Err(format!("`{ts_name}` is defined in both {} and {} -- add a rename", existing.source, source.path));
            }
            decls.insert(ts_name, Decl { docs, body, referenced, source: source.path });
        }
        for name in source.only.unwrap_or(&[]) {
            if !found.contains(*name) {
                return Err(format!("`{name}` isn't defined in {}", source.path));
            }
        }
    }

    let known: BTreeSet<&str> = decls.keys().map(String::as_str).chain(ALIASES.iter().map(|(name, _, _)| *name)).collect();
    for (name, decl) in &decls {
        if let Some(missing) = decl.referenced.iter().find(|r| !known.contains(r.as_str())) {
            return Err(format!("`{name}` ({}) references `{missing}`, which isn't generated -- add its source file", decl.source));
        }
    }

    let mut out = String::new();
    out.push_str("// Generated by tools/typegen from the Rust wire types -- do not edit.\n");
    out.push_str("// Regenerate with `npm run typegen` (in web/).\n\n");
    for (name, ts, doc) in ALIASES {
        let _ = writeln!(out, "/** {doc} */\nexport type {name} = {ts};");
    }
    for (_, decl) in decls {
        out.push('\n');
        out.push_str(&jsdoc(&decl.docs, ""));
        out.push_str(&decl.body);
        out.push('\n');
    }
    Ok(out)
}

fn rename(source: &Source, name: &str) -> String {
    source.rename.iter().find(|(from, _)| *from == name).map_or_else(|| name.to_string(), |(_, to)| to.to_string())
}

/// A public struct or enum's name and docs, and whether it's a serde type.
fn item_header(item: &Item) -> Option<(String, Vec<String>, bool)> {
    let (vis, ident, attrs) = match item {
        Item::Struct(s) => (&s.vis, &s.ident, &s.attrs),
        Item::Enum(e) => (&e.vis, &e.ident, &e.attrs),
        _ => return None,
    };
    if !matches!(vis, syn::Visibility::Public(_)) {
        return None;
    }
    Some((ident.to_string(), docs(attrs), is_serde(attrs)))
}

/// Derives Serialize/Deserialize, or is an entry (`hdk_entry_helper`
/// implies both).
fn is_serde(attrs: &[Attribute]) -> bool {
    attrs.iter().any(|attr| {
        let path = attr.path();
        if path.is_ident("hdk_entry_helper") {
            return true;
        }
        if !path.is_ident("derive") {
            return false;
        }
        let mut serde = false;
        let _ = attr.parse_nested_meta(|meta| {
            if meta.path.segments.last().is_some_and(|s| s.ident == "Serialize" || s.ident == "Deserialize") {
                serde = true;
            }
            Ok(())
        });
        serde
    })
}

fn docs(attrs: &[Attribute]) -> Vec<String> {
    attrs
        .iter()
        .filter(|attr| attr.path().is_ident("doc"))
        .filter_map(|attr| match &attr.meta {
            syn::Meta::NameValue(nv) => match &nv.value {
                syn::Expr::Lit(syn::ExprLit { lit: syn::Lit::Str(s), .. }) => Some(s.value().strip_prefix(' ').map(str::to_string).unwrap_or_else(|| s.value())),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

fn jsdoc(lines: &[String], indent: &str) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let mut out = format!("{indent}/**\n");
    for line in lines {
        // `*/` would end the comment early.
        let line = line.replace("*/", "*\\/");
        let _ = writeln!(out, "{indent} *{}{line}", if line.is_empty() { "" } else { " " });
    }
    let _ = writeln!(out, "{indent} */");
    out
}

fn emit_item(item: &Item, name: &str, source: &Source, referenced: &mut BTreeSet<String>) -> Result<String, String> {
    let context = |what: &str| format!("{what} in `{name}` ({})", source.path);
    match item {
        Item::Struct(s) => {
            if !s.generics.params.is_empty() {
                return Err(context("generic struct"));
            }
            match &s.fields {
                Fields::Named(fields) => Ok(format!("export interface {name} {{\n{}}}", emit_fields(&fields.named, "  ", referenced, &context)?)),
                Fields::Unnamed(fields) if fields.unnamed.len() == 1 => Ok(format!("export type {name} = {};", ts_type(&fields.unnamed[0].ty, referenced, &context)?)),
                _ => Err(context("unsupported struct shape")),
            }
        }
        Item::Enum(e) => {
            if !e.generics.params.is_empty() {
                return Err(context("generic enum"));
            }
            let mut variants = Vec::new();
            for variant in &e.variants {
                let tag = variant.ident.to_string();
                let docs = jsdoc(&docs(&variant.attrs), "  ");
                let ts = match &variant.fields {
                    Fields::Unit => format!("\"{tag}\""),
                    Fields::Unnamed(fields) if fields.unnamed.len() == 1 => format!("{{ {tag}: {} }}", ts_type(&fields.unnamed[0].ty, referenced, &context)?),
                    Fields::Unnamed(fields) => {
                        let items = fields.unnamed.iter().map(|f| ts_type(&f.ty, referenced, &context)).collect::<Result<Vec<_>, _>>()?;
                        format!("{{ {tag}: [{}] }}", items.join(", "))
                    }
                    Fields::Named(fields) => format!("{{\n      {tag}: {{\n{}      }};\n    }}", emit_fields(&fields.named, "        ", referenced, &context)?),
                };
                variants.push((docs, ts));
            }
            if variants.iter().all(|(docs, ts)| docs.is_empty() && ts.starts_with('"')) {
                let tags: Vec<_> = variants.into_iter().map(|(_, ts)| ts).collect();
                return Ok(format!("export type {name} = {};", tags.join(" | ")));
            }
            let mut out = format!("export type {name} =");
            for (docs, ts) in variants {
                out.push('\n');
                out.push_str(&docs);
                let _ = write!(out, "  | {ts}");
            }
            out.push(';');
            Ok(out)
        }
        _ => unreachable!("item_header only admits structs and enums"),
    }
}

fn emit_fields(
    fields: &syn::punctuated::Punctuated<syn::Field, syn::token::Comma>,
    indent: &str,
    referenced: &mut BTreeSet<String>,
    context: &dyn Fn(&str) -> String,
) -> Result<String, String> {
    let mut out = String::new();
    for field in fields {
        let field_name = field.ident.as_ref().expect("named field").to_string();
        out.push_str(&jsdoc(&docs(&field.attrs), indent));
        let _ = writeln!(out, "{indent}{field_name}: {};", ts_type(&field.ty, referenced, context)?);
    }
    Ok(out)
}

fn ts_type(ty: &Type, referenced: &mut BTreeSet<String>, context: &dyn Fn(&str) -> String) -> Result<String, String> {
    match ty {
        Type::Path(path) => {
            let segment = path.path.segments.last().ok_or_else(|| context("empty type path"))?;
            let name = segment.ident.to_string();
            let args: Vec<&Type> = match &segment.arguments {
                PathArguments::AngleBracketed(a) => a.args.iter().filter_map(|arg| if let GenericArgument::Type(t) = arg { Some(t) } else { None }).collect(),
                _ => Vec::new(),
            };
            Ok(match (name.as_str(), args.as_slice()) {
                ("String" | "str", []) => "string".into(),
                ("bool", []) => "boolean".into(),
                ("u8" | "u16" | "u32" | "u64" | "usize" | "i8" | "i16" | "i32" | "i64" | "isize" | "f32" | "f64", []) => "number".into(),
                ("Option", [inner]) => format!("{} | null", ts_type(inner, referenced, context)?),
                ("Vec", [inner]) if matches!(inner, Type::Path(p) if p.path.is_ident("u8")) => "Uint8Array".into(),
                ("Vec", [inner]) => {
                    let inner = ts_type(inner, referenced, context)?;
                    if inner.contains(' ') { format!("({inner})[]") } else { format!("{inner}[]") }
                }
                ("Box", [inner]) => ts_type(inner, referenced, context)?,
                (_, []) => {
                    referenced.insert(name.clone());
                    name
                }
                _ => return Err(context(&format!("unsupported generic type `{name}`"))),
            })
        }
        Type::Tuple(tuple) if tuple.elems.is_empty() => Ok("null".into()),
        Type::Tuple(tuple) => {
            let items = tuple.elems.iter().map(|t| ts_type(t, referenced, context)).collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[{}]", items.join(", ")))
        }
        _ => Err(context("unsupported type")),
    }
}
