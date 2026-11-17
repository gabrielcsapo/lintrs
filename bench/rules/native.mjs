import { nativePlugin } from "__LINTRS_NATIVE__";

export default nativePlugin({
  name: "bench",
  rules: ["call-returns-union"],
  crate: new URL("./rust/", import.meta.url),
});
