/** Keep HeroUI's BEM classes and theme defaults out of Studio's existing chrome. */
export default function scopeHeroUI() {
  return {
    postcssPlugin: "tessera-scope-heroui",
    Once(root) {
      root.walkRules((rule) => {
        const file = rule.source?.input.file ?? "";
        if (!file.includes("@heroui/styles") && !file.includes("@heroui+styles")) return;
        if (rule.parent?.type === "rule" || rule.parent?.name?.endsWith("keyframes")) return;
        const selectors = rule.selectors.flatMap((selector) => {
          if (selector.includes(":host")) return [];
          if (selector === "*") return [":where(.tessera-heroui) *"];
          if (selector === ":root") return [".tessera-heroui"];
          if (/^(?:\.(?:light|dark|default)|\[data-theme=)/.test(selector)) {
            return [`:where(${selector}) .tessera-heroui`, `.tessera-heroui:where(${selector})`];
          }
          return [`:where(.tessera-heroui) ${selector}`, `:where(.tessera-heroui)${selector}`];
        });
        if (selectors.length === 0) rule.remove();
        else rule.selectors = selectors;
      });
    },
  };
}
scopeHeroUI.postcss = true;
