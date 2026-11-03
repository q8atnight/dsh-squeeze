// Resolve @deepseek-ai/* from the installed DSH app (test runs only; DSH does this itself at runtime).
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = process.env.DSH_NODE_MODULES ?? "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/";
registerHooks({
	resolve(specifier, context, next) {
		if (specifier.startsWith("@deepseek-ai/") && !context.parentURL?.includes("app.asar")) {
			return next(specifier, { ...context, parentURL: pathToFileURL(ROOT + "@deepseek-ai/dsh-llm/package.json").href });
		}
		return next(specifier, context);
	},
});
