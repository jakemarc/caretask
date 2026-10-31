import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  createAppointmentCategory,
  deactivateAppointmentCategory,
  isPinRejection,
  listAppointmentCategories,
  restoreAppointmentCategory,
  updateAppointmentCategory,
  verifyManagerPin,
  type AppointmentCategory,
  type CategoryInput,
} from "../lib/patientApi";

// Settings → Visit categories. Practice configuration for the
// calendar: each category's default visit time, name, color, and
// type (visit vs provider block), plus adding new categories and
// deactivating ones the practice doesn't use. All writes are
// manager-PIN gated (verified against the API, held in memory only
// while Settings is open) — the same pattern as staff management.

interface Props {
  user: User;
  apiConnected: boolean;
  // "card" is the slim Settings card (Add + List categories buttons);
  // "page" is the separate full page that shows the list itself.
  variant?: "card" | "page";
  onListCategories?: () => void;
}

type Pending =
  | { kind: "save" }
  | { kind: "deactivate"; cat: AppointmentCategory }
  | { kind: "restore"; cat: AppointmentCategory };

export default function VisitCategoriesSettings({
  user,
  apiConnected,
  variant = "card",
  onListCategories,
}: Props) {
  const [cats, setCats] = useState<AppointmentCategory[] | null>(null);
  // Jake, 2026-10-30: Settings card keeps just Add category +
  // List categories; the list itself lives on its own page
  // (variant="page") with a Back to Settings button.
  const isPage = variant === "page";
  const [notice, setNotice] = useState("");
  const [formFor, setFormFor] = useState<AppointmentCategory | null>(
    null,
  );
  const [formOpen, setFormOpen] = useState(false);
  const [fName, setFName] = useState("");
  const [fColor, setFColor] = useState("#2563eb");
  const [fCattype, setFCattype] = useState<"appointment" | "provider">(
    "appointment",
  );
  const [fDuration, setFDuration] = useState(45);
  const [fDescription, setFDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const [pending, setPending] = useState<Pending | null>(null);
  const [pinEntry, setPinEntry] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinChecking, setPinChecking] = useState(false);
  const [verifiedPin, setVerifiedPin] = useState("");
  const [authorizer, setAuthorizer] = useState("");

  useEffect(() => {
    if (!apiConnected) return;
    let live = true;
    (async () => {
      try {
        const rows = await listAppointmentCategories(user, true);
        if (live) setCats(rows);
      } catch {
        if (live) setNotice("Couldn't load the category list.");
      }
    })();
    return () => {
      live = false;
    };
  }, [apiConnected, user]);

  function openCreate() {
    setFormFor(null);
    setFName("");
    setFColor("#2563eb");
    setFCattype("appointment");
    setFDuration(45);
    setFDescription("");
    setFormOpen(true);
  }

  function openEdit(c: AppointmentCategory) {
    setFormFor(c);
    setFName(c.name);
    setFColor(c.color);
    setFCattype(c.cattype);
    setFDuration(c.default_duration_min);
    setFDescription(c.description ?? "");
    setFormOpen(true);
  }

  function buildInput(): CategoryInput {
    return {
      name: fName.trim(),
      color: fColor,
      cattype: fCattype,
      default_duration_min: fDuration,
      description: fDescription.trim() || null,
    };
  }

  async function doSave(pin: string) {
    setSaving(true);
    try {
      if (formFor) {
        const updated = await updateAppointmentCategory(
          user,
          formFor.id,
          buildInput(),
          pin,
        );
        setCats((prev) =>
          (prev ?? []).map((c) => (c.id === updated.id ? updated : c)),
        );
      } else {
        const created = await createAppointmentCategory(
          user,
          buildInput(),
          pin,
        );
        setCats((prev) => [...(prev ?? []), created]);
      }
      setFormOpen(false);
      setPending(null);
      setNotice("");
    } catch (err) {
      if (isPinRejection(err)) {
        setVerifiedPin("");
        setPinError("That PIN was rejected — try again.");
        setPending({ kind: "save" });
      } else {
        setNotice(
          err instanceof Error ? err.message : "Couldn't save the category.",
        );
        setPending(null);
      }
    } finally {
      setSaving(false);
    }
  }

  async function doDeactivate(cat: AppointmentCategory, pin: string) {
    try {
      await deactivateAppointmentCategory(user, cat.id, pin);
      setCats((prev) =>
        (prev ?? []).map((c) =>
          c.id === cat.id ? { ...c, active: false } : c,
        ),
      );
      setPending(null);
    } catch (err) {
      if (isPinRejection(err)) {
        setVerifiedPin("");
        setPinError("That PIN was rejected — try again.");
      } else setNotice("Couldn't deactivate the category.");
    }
  }

  async function doRestore(cat: AppointmentCategory, pin: string) {
    try {
      const restored = await restoreAppointmentCategory(user, cat.id, pin);
      setCats((prev) =>
        (prev ?? []).map((c) => (c.id === restored.id ? restored : c)),
      );
      setPending(null);
    } catch (err) {
      if (isPinRejection(err)) {
        setVerifiedPin("");
        setPinError("That PIN was rejected — try again.");
      } else setNotice("Couldn't reactivate the category.");
    }
  }

  function requestSave() {
    if (!fName.trim()) return setNotice("Give the category a name.");
    if (!Number.isInteger(fDuration) || fDuration <= 0)
      return setNotice("Visit time must be a positive number of minutes.");
    if (verifiedPin) void doSave(verifiedPin);
    else {
      setPinError("");
      setPinEntry("");
      setPending({ kind: "save" });
    }
  }

  function requestToggle(cat: AppointmentCategory) {
    const p: Pending = cat.active
      ? { kind: "deactivate", cat }
      : { kind: "restore", cat };
    if (verifiedPin) {
      if (p.kind === "deactivate") void doDeactivate(cat, verifiedPin);
      else void doRestore(cat, verifiedPin);
    } else {
      setPinError("");
      setPinEntry("");
      setPending(p);
    }
  }

  async function submitPin() {
    const pin = pinEntry.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      setPinError("PINs are 4–8 digits.");
      return;
    }
    setPinChecking(true);
    setPinError("");
    try {
      const manager = await verifyManagerPin(user, pin);
      setVerifiedPin(pin);
      setAuthorizer(manager.name);
      if (pending?.kind === "save") void doSave(pin);
      else if (pending?.kind === "deactivate")
        void doDeactivate(pending.cat, pin);
      else if (pending?.kind === "restore")
        void doRestore(pending.cat, pin);
    } catch {
      setPinError("Incorrect PIN.");
    } finally {
      setPinChecking(false);
    }
  }

  const pendingLabel =
    pending?.kind === "save"
      ? formFor
        ? `save changes to ${formFor.name}`
        : "add this category"
      : pending?.kind === "deactivate"
        ? `deactivate ${pending.cat.name}`
        : pending?.kind === "restore"
          ? `reactivate ${pending.cat.name}`
          : "";

  if (!apiConnected) {
    return (
      <article className="card">
        <strong>Visit categories</strong>
        <p>
          Visit types and their default times live in the CareTask
          database — they can't be loaded or changed while the API is
          unreachable.
        </p>
      </article>
    );
  }

  return (
    <article className="card">
      <div className="card-top">
        <strong>Visit categories</strong>
        <span className="flag-actions">
          <button className="btn btn-primary" onClick={openCreate}>
            + Add category
          </button>
          {!isPage && (
            <button
              className="btn btn-secondary"
              onClick={onListCategories}
            >
              List categories
            </button>
          )}
        </span>
      </div>
      {notice && <p className="pin-error">{notice}</p>}
      {isPage && authorizer && (
        <p className="card-meta">
          Manager PIN verified for {authorizer} — changes this session
          skip the prompt.
        </p>
      )}
      {isPage && (
      <div className="card-list">
        {(cats ?? []).map((c) => (
          <div key={c.id} className="cat-row">
            <span
              className="cat-swatch"
              style={{ background: c.color }}
              aria-hidden
            />
            <span className="cat-main">
              <strong>{c.name}</strong>
              <span className="card-meta">
                {" "}
                · {c.default_duration_min} min ·{" "}
                {c.cattype === "provider" ? "Provider block" : "Visit"}
                {c.active ? "" : " · Inactive"}
              </span>
              {c.description && <p>{c.description}</p>}
            </span>
            <span className="flag-actions">
              <button className="btn" onClick={() => openEdit(c)}>
                Edit
              </button>
              <button
                className={c.active ? "btn btn-danger" : "btn"}
                onClick={() => requestToggle(c)}
              >
                {c.active ? "Deactivate" : "Reactivate"}
              </button>
            </span>
          </div>
        ))}
        {cats === null && <p className="section-note">Loading…</p>}
      </div>
      )}

      {pending && (
        <form
          className="pin-panel"
          onSubmit={(e) => {
            e.preventDefault();
            void submitPin();
          }}
        >
          <label>
            Manager PIN required to {pendingLabel}
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pinEntry}
              onChange={(e) => setPinEntry(e.target.value)}
              placeholder="PIN"
            />
          </label>
          <p>Enter any active manager or admin PIN.</p>
          {pinError && <p className="pin-error">{pinError}</p>}
          <div className="profile-actions">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={pinChecking}
            >
              {pinChecking ? "Verifying…" : "Unlock"}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {formOpen && (
        <div className="cal-form cat-form">
          <h3>{formFor ? `Edit ${formFor.name}` : "New category"}</h3>
          <div className="form-grid">
            <label>
              Name
              <input
                type="text"
                value={fName}
                onChange={(e) => setFName(e.target.value)}
                placeholder="e.g. Wound Care Visit"
              />
            </label>
            <label>
              Kind
              <select
                value={fCattype}
                onChange={(e) =>
                  setFCattype(
                    e.target.value as "appointment" | "provider",
                  )
                }
              >
                <option value="appointment">
                  Visit (has a patient)
                </option>
                <option value="provider">
                  Provider block (no patient)
                </option>
              </select>
            </label>
            <label>
              Default visit time (minutes)
              <input
                type="number"
                min={5}
                max={1440}
                step={5}
                value={fDuration}
                onChange={(e) => setFDuration(Number(e.target.value))}
              />
            </label>
            <label>
              Color
              <span className="cat-color-row">
                <input
                  type="color"
                  value={fColor}
                  onChange={(e) => setFColor(e.target.value)}
                />
                <input
                  type="text"
                  value={fColor}
                  onChange={(e) => setFColor(e.target.value)}
                />
              </span>
            </label>
            <label className="form-wide">
              Description
              <input
                type="text"
                value={fDescription}
                onChange={(e) => setFDescription(e.target.value)}
                placeholder="Optional — what this visit type is for"
              />
            </label>
          </div>
          <div className="profile-actions">
            <button
              className="btn btn-primary"
              disabled={saving}
              onClick={requestSave}
            >
              {saving ? "Saving…" : "Save category"}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setFormOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
