import {
  createNativeStackNavigator,
  createNativeStackScreen,
} from "@react-navigation/native-stack";
import { Platform } from "react-native";

import { NewProjectFolderScreen } from "./NewProjectFolderScreen";
import { NewProjectScreen } from "./NewProjectScreen";
import { ProjectFileScreen } from "./ProjectFileScreen";
import { ProjectScheduleEditorScreen } from "./ProjectScheduleEditorScreen";
import { ProjectSchedulesScreen } from "./ProjectSchedulesScreen";

// Fork-owned. The Project sheet's nested stack, following the new-task sheet
// in Stack.tsx: a plain formSheet screen cannot render a stack header, so the
// header and in-sheet pushes come from this navigator. The file view scrolls
// internally, so its header is solid. New Project pushes its folder picker,
// and Schedules pushes its editor.
export const ProjectSheetStack = createNativeStackNavigator({
  initialRouteName: "ProjectFile",
  screenOptions: {
    headerBackButtonDisplayMode: "minimal",
    headerBackTitle: "",
    headerLargeTitle: false,
    headerShadowVisible: false,
    headerShown: true,
    headerTitleStyle: { fontSize: 17, fontWeight: "400" },
    headerTransparent: false,
    // The sheet host owns the one opaque surface, as in the new-task sheet.
    contentStyle: Platform.OS === "ios" ? { backgroundColor: "transparent" } : undefined,
  },
  screens: {
    ProjectFile: createNativeStackScreen({
      screen: ProjectFileScreen,
      linking: ":environmentId/:projectId/files/:path",
      options: { title: "" },
    }),
    ProjectSchedules: createNativeStackScreen({
      screen: ProjectSchedulesScreen,
      linking: ":environmentId/:projectId/schedules",
      options: { title: "Schedules" },
    }),
    ProjectScheduleEditor: createNativeStackScreen({
      // No link: the editor reads the schedule it opens from a loaded list.
      screen: ProjectScheduleEditorScreen,
      options: { title: "Schedule" },
    }),
    NewProject: createNativeStackScreen({
      screen: NewProjectScreen,
      linking: "new",
      options: { title: "New Project" },
    }),
    NewProjectFolder: createNativeStackScreen({
      screen: NewProjectFolderScreen,
      linking: "new/folder",
      options: { title: "Choose folder" },
    }),
  },
});
