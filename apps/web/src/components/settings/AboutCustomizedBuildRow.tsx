import { CUSTOMIZED_BUILD } from "../../branding";
import { SettingsRow } from "./settingsLayout";

// t3code-customize: which customized build is running (patches-tt/0005).
export function AboutCustomizedBuildRow() {
  if (!CUSTOMIZED_BUILD) {
    return null;
  }
  return (
    <SettingsRow
      id="about-customized-build"
      title={
        <span className="inline-flex items-baseline gap-2">
          <span>Customized build</span>
          <code className="text-2xs font-medium text-muted-foreground">
            {CUSTOMIZED_BUILD.recipe}
          </code>
        </span>
      }
      description={
        CUSTOMIZED_BUILD.builtAt
          ? `Built by t3code-customize on ${CUSTOMIZED_BUILD.builtAt.toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}.`
          : "Built by t3code-customize."
      }
    />
  );
}
