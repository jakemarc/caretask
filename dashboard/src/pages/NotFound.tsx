import { Link } from "react-router-dom";
import Mark from "../components/Mark";

export default function NotFound() {
  return (
    <div className="login-page">
      <div className="login-card">
        <Mark size={48} />
        <h1>Page not found</h1>
        <p className="login-sub">
          That page does not exist in the clinician dashboard.
        </p>
        <Link className="btn btn-primary" to="/app">
          Go to the dashboard
        </Link>
      </div>
    </div>
  );
}
