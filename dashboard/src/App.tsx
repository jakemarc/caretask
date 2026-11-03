import { useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "./lib/firebase";
import {
  COLOR_THEME_STORAGE_KEY,
  initialColorTheme,
  initialTheme,
  THEME_STORAGE_KEY,
  type ColorTheme,
  type Theme,
} from "./lib/theme";
import Login from "./pages/Login";
import AcceptInvite from "./pages/AcceptInvite";
import Dashboard from "./pages/Dashboard";
import NotFound from "./pages/NotFound";

// Signed-out visitors are sent to /login. When Firebase is not configured
// yet, auth is null, so every /app visit lands on the login page's setup
// notice — there is no way to reach the dashboard without signing in.
function RequireAuth({
  children,
}: {
  children: (user: User) => ReactNode;
}) {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    if (!auth) {
      setUser(null);
      return;
    }
    return onAuthStateChanged(auth, setUser);
  }, []);

  if (user === undefined) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children(user)}</>;
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [colorTheme, setColorTheme] =
    useState<ColorTheme>(initialColorTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Private mode: the theme still applies for this session.
    }
  }, [theme]);

  // Same mechanism as the mode above, on the second axis:
  // data-color-theme on <html> + its own localStorage key.
  useEffect(() => {
    document.documentElement.dataset.colorTheme = colorTheme;
    try {
      localStorage.setItem(COLOR_THEME_STORAGE_KEY, colorTheme);
    } catch {
      // Private mode: the color theme still applies for this session.
    }
  }, [colorTheme]);

  const toggleTheme = () =>
    setTheme((t) => (t === "light" ? "dark" : "light"));

  return (
    <Routes>
      <Route
        path="/login"
        element={<Login theme={theme} onToggleTheme={toggleTheme} />}
      />
      <Route
        path="/accept-invite"
        element={<AcceptInvite theme={theme} onToggleTheme={toggleTheme} />}
      />
      <Route
        path="/app"
        element={
          <RequireAuth>
            {(user) => (
              <Dashboard
                user={user}
                theme={theme}
                onToggleTheme={toggleTheme}
                colorTheme={colorTheme}
                onColorThemeChange={setColorTheme}
              />
            )}
          </RequireAuth>
        }
      />
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
