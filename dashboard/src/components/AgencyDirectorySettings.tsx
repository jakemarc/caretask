import type { User } from "firebase/auth";
import AgencySyncPanel from "./AgencySyncPanel";

// Settings → Agency directory. The same sync the Agency tab
// runs ("Sync now" there, "Update agencies" here) against the
// same PIN-gated POST /agencies/sync — one directory, two doors.
// Patterned on Settings → Visit categories: a self-contained
// article in the Settings card list.

export default function AgencyDirectorySettings({
  user,
  apiConnected,
}: {
  user: User;
  apiConnected: boolean;
}) {
  return (
    <article className="card">
      <div className="card-top">
        <strong>Agency directory</strong>
      </div>
      <AgencySyncPanel
        user={user}
        apiConnected={apiConnected}
        buttonLabel="Update agencies"
      />
    </article>
  );
}
