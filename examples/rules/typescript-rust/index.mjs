import { nativePlugin } from "@lintrs/cli/native";

export default nativePlugin({
  name: "example",
  rules: ["call-returns-union"],
  crate: new URL("./", import.meta.url),
});
