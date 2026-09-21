import type { Shot } from "./shot.ts";
import { denOmniRushWeb, denPluginDetail, denSkillEditor } from "./den-web.ts";
import {
  desktopTeamPromptCards,
  libraryAddMcpModal,
  libraryAdvancedSettings,
  libraryCreateSkillModal,
  librarySkills,
  skillCreatedCard,
} from "./desktop.ts";
import { omnirushWebTab } from "./web-tab.ts";

export const shots: Shot[] = [
  desktopTeamPromptCards,
  librarySkills,
  libraryCreateSkillModal,
  libraryAdvancedSettings,
  libraryAddMcpModal,
  skillCreatedCard,
  denPluginDetail,
  denSkillEditor,
  denOmniRushWeb,
  omnirushWebTab,
];
