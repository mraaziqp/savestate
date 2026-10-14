// Entry for dist/assets/NexusApp-<rev>.js. The app shell lazy-loads these
// (see build.mjs for where each one is wired in):
//   Welcome       signed-out visitors on the web
//   AuthForm      the sign-in form inside the app (Profile, client onboarding)
//   PlansPage     the Plans tab: pricing for members, the plans console for admins
//   TabGate       upgrade / request-access screens over a tab that is not available
//   EmulationTab  Games > Emulation Setup: the setup guide, plus host tools for admins
export { Welcome } from "./Welcome.jsx";
export { AuthForm } from "./AuthForm.jsx";
export { PlansPage } from "./Plans.jsx";
export { TabGate } from "./TabGate.jsx";
export { SetupGuide as EmulationTab } from "./SetupGuide.jsx";
export { DrivesPage } from "./Drives.jsx";
export { MyDrives } from "./MyDrives.jsx";
export { Household, ProfileLayer } from "./Household.jsx";
export { DownloaderSetup } from "./Downloader.jsx";
export { MediaUploader } from "./MediaUpload.jsx";
