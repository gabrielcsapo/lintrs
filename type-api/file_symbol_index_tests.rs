#[test]
fn lintrs_cached_file_symbols_match_original_search_and_release() {
    const SOURCE: &str = r#"
import { Box as ImportedBox, exported } from './other';
export { exported as renamed };
export interface Merged { first: string }
export interface Merged { second: number }
export class Container { member = exported; method(input: ImportedBox) { return input; } }
export namespace Container { export const nested = exported; }
/** @typedef {{ docMember: string }} Documented */
export function use(input: ImportedBox) { const local = input; return local; }
"#;
    const DEPENDENCY: &str = r#"
export interface Box { value: string }
export const exported = { nested: { item: 'value' } };
export namespace Space { export interface Inside { member: string } }
"#;
    const AMBIENT: &str = r#"
declare module 'virtual-*' { export interface Pattern { member: string }; export const value: Pattern; }
declare namespace Ambient { interface Global { value: string }; const globalValue: Global; }
"#;
    let host = TestHost::new(&[
        (
            "/p/tsconfig.json",
            r#"{"compilerOptions":{"strict":true,"target":"ES2022","module":"CommonJS"},"include":["*.ts"]}"#,
        ),
        ("/p/main.ts", SOURCE),
        ("/p/other.ts", DEPENDENCY),
        ("/p/ambient.d.ts", AMBIENT),
    ]);
    let program = host.program();
    program.bind_source_files();
    assert_eq!(host.registry.file_symbol_cache_count(), 0);
    let mut checked = 0;
    for path in ["/p/main.ts", "/p/other.ts", "/p/ambient.d.ts"] {
        let file = program.get_source_file(path).unwrap();
        assert!(file.is_bound());
        let index = super::symbol_index::build_source_file_symbol_index(file);
        assert!(!index.is_empty(), "{path}");
        for (id, symbol) in &index {
            assert_eq!(
                super::symbol_index::source_file_symbol(file, *id),
                Some(*symbol)
            );
            assert_eq!(
                host.registry.cached_file_symbol(file, *id).unwrap(),
                Some(*symbol)
            );
            assert!(!symbol.flags().intersects(tsrs_ast::SymbolFlags::Transient));
            assert_eq!(tsrs_ast::get_source_file_of_symbol(*symbol), Some(file));
            checked += 1;
        }
        for absent in [0, u64::MAX] {
            assert_eq!(super::symbol_index::source_file_symbol(file, absent), None);
            assert_eq!(
                host.registry.cached_file_symbol(file, absent).unwrap(),
                None
            );
        }
    }
    assert!(checked >= 20, "insufficient symbol coverage: {checked}");
    assert_eq!(host.registry.file_symbol_cache_count(), 3);
    host.registry.release();
    assert_eq!(host.registry.file_symbol_cache_count(), 0);
    assert!(
        host.registry
            .cached_file_symbol(program.get_source_file("/p/main.ts").unwrap(), 0)
            .is_err()
    );
}
