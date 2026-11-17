#[test]
fn lintrs_compact_symbol_facts_match_scalar_queries_and_declaration_headers() {
    const SOURCE: &str = "// Unicode Ω𐐀\nimport { target as local } from './other'; export const value = local; export interface Merged { first: string }; export interface Merged { second: number }; export const unused = 'none';";
    let host = TestHost::new(&[
        (
            "/p/tsconfig.json",
            r#"{"compilerOptions":{"strict":true,"module":"CommonJS"},"include":["*.ts"]}"#,
        ),
        ("/p/main.ts", SOURCE),
        (
            "/p/other.ts",
            "// Unicode Ω𐐀\nexport const target = 'hello';",
        ),
    ]);
    let locations = ["local }", "value =", "Merged {", "'none'", "local }"]
        .map(|needle| host.handle_at("/p/main.ts", SOURCE, needle));
    let location_values = Value::Array(locations.iter().cloned().map(Value::String).collect());
    let locations_json = json::marshal(&location_values).unwrap();
    let call = |aliases: bool| {
        let value = json::unmarshal(&host.sp(&format!(
            r#""locations":{locations_json},"resolveAliases":{aliases}"#
        )))
        .unwrap();
        let params = super::params::Params::new(&value, "lintrsGetSymbolFacts").unwrap();
        super::handlers_symbols::lintrs_get_symbol_facts(&host, &params).unwrap()
    };
    for aliases in [false, true] {
        let batch = call(aliases);
        let value = json::unmarshal(&host.sp(&format!(
            r#""locations":{locations_json},"resolveAliases":{aliases},"includeDeclarations":false"#
        )))
        .unwrap();
        let params = super::params::Params::new(&value, "lintrsGetSymbolFacts").unwrap();
        let without_headers =
            super::handlers_symbols::lintrs_get_symbol_facts(&host, &params).unwrap();
        assert_eq!(field(&without_headers, "results"), field(&batch, "results"));
        assert!(arr(field(&without_headers, "declarations")).is_empty());
        let results = arr(field(&batch, "results"));
        for (location, result) in locations.iter().zip(results) {
            let symbol = host.ok(
                "getSymbolAtLocation",
                &host.sp(&format!(r#""location":"{location}""#)),
            );
            assert_eq!(field(result, "symbol"), &symbol);
            if aliases
                && symbol != Value::Null
                && num(&symbol, "flags") & tsrs_ast::SymbolFlags::Alias.bits() as u64 != 0
            {
                let expected = host.ok(
                    "getAliasedSymbol",
                    &host.sp(&format!(r#""symbol":{}"#, host.symbol_ref(&symbol))),
                );
                assert_eq!(field(result, "alias"), &expected);
                let value =
                    json::unmarshal(&host.sp(&format!(r#""symbol":{}"#, host.symbol_ref(&symbol))))
                        .unwrap();
                let params =
                    super::params::Params::new(&value, "lintrsGetAliasedSymbolFacts").unwrap();
                let alias = super::handlers_symbols::lintrs_get_aliased_symbol_facts(&host, &params)
                    .unwrap();
                assert_eq!(field(&alias, "symbol"), &expected);
                assert!(!arr(field(&alias, "declarations")).is_empty());
                let value = json::unmarshal(&host.sp(&format!(
                    r#""symbol":{},"includeDeclarations":false"#,
                    host.symbol_ref(&symbol)
                )))
                .unwrap();
                let params =
                    super::params::Params::new(&value, "lintrsGetAliasedSymbolFacts").unwrap();
                let without_headers =
                    super::handlers_symbols::lintrs_get_aliased_symbol_facts(&host, &params)
                        .unwrap();
                assert_eq!(field(&without_headers, "symbol"), &expected);
                assert!(arr(field(&without_headers, "declarations")).is_empty());
            } else {
                let Value::Object(fields) = result else {
                    panic!("invalid result")
                };
                assert!(!fields.contains_key("alias"));
            }
        }
        assert_eq!(field(&results[3], "symbol"), &Value::Null);
        assert_eq!(
            arr(field(field(&results[2], "symbol"), "declarations")).len(),
            2
        );
        let mut seen = rustc_hash::FxHashSet::default();
        for header in arr(field(&batch, "declarations")) {
            let id = str_of(field(header, "id"));
            assert!(seen.insert(id.clone()));
            let node = host.resolve_node_handle(host.program(), &id).unwrap();
            let file = tsrs_ast::get_source_file_of_node(node).unwrap();
            assert_eq!(num(header, "kind"), node.kind() as u64);
            assert_eq!(num(header, "flags"), node.flags().bits() as u64);
            assert_eq!(
                num(header, "pos"),
                file.text()[..node.pos() as usize].encode_utf16().count() as u64
            );
            assert_eq!(
                num(header, "end"),
                file.text()[..node.end() as usize].encode_utf16().count() as u64
            );
        }
        assert!(!seen.is_empty());
    }
    let file = host.program().get_source_file("/p/main.ts").unwrap();
    let positions = host.registry.compact_declaration_positions(file).unwrap();
    assert!(std::sync::Arc::ptr_eq(
        &positions,
        &host.registry.compact_declaration_positions(file).unwrap()
    ));
    host.registry.release();
    assert!(host.registry.compact_declaration_positions(file).is_err());
}
