#[test]
fn lintrs_contextual_batch_matches_scalar_and_validates_all_locations() {
    const SOURCE: &str = "export const typed: string = 'hello'; export const inferred = 42;";
    let host = TestHost::new(&[
        (
            "/p/tsconfig.json",
            r#"{"compilerOptions":{"strict":true},"files":["main.ts"]}"#,
        ),
        ("/p/main.ts", SOURCE),
    ]);
    let locations = [
        host.handle_at("/p/main.ts", SOURCE, "'hello'"),
        host.handle_at("/p/main.ts", SOURCE, "42"),
        host.handle_at("/p/main.ts", SOURCE, "typed:"),
    ];
    let expected = locations
        .iter()
        .map(|location| {
            host.ok(
                "getContextualType",
                &host.sp(&format!(r#""location":"{location}""#)),
            )
        })
        .collect::<Vec<_>>();
    assert_ne!(expected[0], Value::Null);
    assert_eq!(expected[1], Value::Null);
    let call = |locations: &[String]| {
        let locations = Value::Array(locations.iter().cloned().map(Value::String).collect());
        let locations = json::marshal(&locations).unwrap();
        let value = json::unmarshal(&host.sp(&format!(r#""locations":{locations}"#))).unwrap();
        let params = super::params::Params::new(&value, "lintrsGetContextualTypes").unwrap();
        super::handlers_types::lintrs_get_contextual_types(&host, &params)
    };
    assert_eq!(call(&locations).unwrap(), Value::Array(expected.clone()));
    assert_eq!(call(&[]).unwrap(), Value::Array(Vec::new()));
    assert_eq!(
        call(&vec![locations[0].clone(); 256]).unwrap(),
        Value::Array(vec![expected[0].clone(); 256])
    );
    assert!(call(&vec![locations[0].clone(); 257]).is_err());
    assert!(call(&[locations[0].clone(), "invalid-node".to_owned()]).is_err());
    assert_eq!(call(&locations).unwrap(), Value::Array(expected));
    host.registry.release();
    assert!(call(&locations).is_err());
}
