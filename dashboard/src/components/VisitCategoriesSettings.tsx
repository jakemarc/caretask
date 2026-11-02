import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  createAppointmentCategory,
  deactivateAppointmentCategory,
  isRoleRejection,
  listAppointmentCategories,
  restoreAppointmentCategory,
  updateAppointmentCategory,
  type AppointmentCategory,
  type CategoryInput,
} from "../lib/patientApi";
import { isManagerRole, useMyStaff } from "../lib/useMyRole";

// Settings → Visit categories. Practice configuration for the
// calendar: each category's default visit time, name, color, and
// type (visit vs provider block), plus adding new categories and
// deactivating ones the practice doesn't use. All writes are
// role-gated (manager/admin) — the API enforces it, and this view
// only offers the write actions to managers (the manager PIN was
// retired on 2026-11-02).

interface Props {
  user: User;
  apiConnected: boolean;
  // "card" is the slim Settings card (Add + List categories buttons);
  // "page" is the separate full page that shows the list itself.
  variant?: "card" | "page";
  onListCategories?: () => void;
}

export default function VisitCategoriesSettings({
  user,
  apiConnected,
  variant = "card",
  onListCategories,
}: Props) {
  const me = useMyStaff(user);
  const isManager = isManagerRole(me);
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
  // Two-step confirm for deactivation (the friction the PIN
  // prompt used to provide, without the PIN).
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

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

  function roleAwareError(err: unknown, fallback: string): string {
    if (isRoleRejection(err))
      return "Changing visit categories needs a manager or admin role.";
    return err instanceof Error ? err.message : fallback;
  }

  async function doSave() {
    setSaving(true);
    try {
      if (formFor) {
        const updated = await updateAppointmentCategory(
          user,
          formFor.id,
          buildInput(),
        );
        setCats((prev) =>
          (prev ?? []).map((c) => (c.id === updated.id ? updated : c)),
        );
      } else {
        const created = await createAppointmentCategory(
          user,
          buildInput(),
        );
        setCats((prev) => [...(prev ?? []), created]);
      }
      setFormOpen(false);
      setNotice("");
    } catch (err) {
      setNotice(roleAwareError(err, "Couldn't save the category."));
    } finally {
      setSaving(false);
    }
  }

  async function doDeactivate(cat: AppointmentCategory) {
    try {
      await deactivateAppointmentCategory(user, cat.id);
      setCats((prev) =>
        (prev ?? []).map((c) =>
          c.id === cat.id ? { ...c, active: false } : c,
        ),
      );
      setConfirmingId(null);
    } catch (err) {
      setNotice(roleAwareError(err, "Couldn't deactivate the category."));
    }
  }

  async function doRestore(cat: AppointmentCategory) {
    try {
      const restored = await restoreAppointmentCategory(user, cat.id);
      setCats((prev) =>
        (prev ?? []).map((c) => (c.id === restored.id ? restored : c)),
      );
    } catch (err) {
      setNotice(roleAwareError(err, "Couldn't reactivate the category."));
    }
  }

  function requestSave() {
    if (!fName.trim()) return setNotice("Give the category a name.");
    if (!Number.isInteger(fDuration) || fDuration <= 0)
      return setNotice("Visit time must be a positive number of minutes.");
    void doSave();
  }

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
          {isManager && (
            <button className="btn btn-primary" onClick={openCreate}>
              + Add category
            </button>
          )}
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
      {isPage && !isManager && (
        <p className="card-meta">
          Changing visit categories needs a manager or admin role —
          this list is read-only for your role.
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
            {isManager && (
              <span className="flag-actions">
                <button className="btn" onClick={() => openEdit(c)}>
                  Edit
                </button>
                {c.active ? (
                  confirmingId === c.id ? (
                    <>
                      <button
                        className="btn btn-danger"
                        onClick={() => void doDeactivate(c)}
                      >
                        Confirm deactivate
                      </button>
                      <button
                        className="btn"
                        onClick={() => setConfirmingId(null)}
                      >
                        Keep
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn-danger"
                      onClick={() => setConfirmingId(c.id)}
                    >
                      Deactivate
                    </button>
                  )
                ) : (
                  <button className="btn" onClick={() => void doRestore(c)}>
                    Reactivate
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
        {cats === null && <p className="section-note">Loading…</p>}
      </div>
      )}

      {formOpen && isManager && (
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
