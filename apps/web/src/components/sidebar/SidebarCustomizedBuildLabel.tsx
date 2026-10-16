import { CUSTOMIZED_BUILD } from "../../branding";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// t3code-customize: which customized build is running, at a glance (patches-tt/0005).
export function SidebarCustomizedBuildLabel() {
  if (!CUSTOMIZED_BUILD) {
    return null;
  }
  const builtAt = CUSTOMIZED_BUILD.builtAt?.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <div className="flex h-7 items-center [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge
              aria-label={`Customized build ${CUSTOMIZED_BUILD.recipe}`}
              size="sm"
              variant="outline"
            />
          }
        >
          {CUSTOMIZED_BUILD.shortRecipe}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          Customized build {CUSTOMIZED_BUILD.recipe}
          {builtAt ? `, built ${builtAt}` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
