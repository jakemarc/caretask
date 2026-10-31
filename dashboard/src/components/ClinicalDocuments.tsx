import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import {
  createDocument,
  deleteDocument,
  finalizeDocument,
  isPinRejection,
  listDocuments,
  updateDocument,
  verifyManagerPin,
  type ApiDocument,
  type ApiRequestError,
} from "../lib/patientApi";
import {
  DOC_TEMPLATES,
  emptySections,
  templateFor,
  type DocType,
} from "../lib/documentTemplates";

// Patient Profile → Clinical Documents panel: Evaluation,
// Reassessment, and Discharge documents on the OpenEMR
// encounter-forms pattern. Drafts are editable; finalized documents
// are locked. Delete is manager-PIN gated exactly like patient
// delete (PIN verified server-side, then it rides along on the
// DELETE itself). Deleted documents leave the chart list (the API
// excludes them, and there is no deleted-documents view), so no
// restore UI lives here — restoreDocument exists in the API client
// for completeness only.

interface Props {
  user: User;
  patientApiId: string;
}

export default function ClinicalDocuments({ user, patientApiId }: Props) {
  const [docs, setDocs] = useState<ApiDocument[] | null>(null);
  const [error, setError] = useState("");

  // Editor state — the document currently open below the list.
  const [selected, setSelected] = useState<ApiDocument | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSections, setEditSections] = useState<Record<string, string>>(
    {},
  );
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [editorError, setEditorError] = useState("");

  // New-document flow: template picker + title.
  const [showNew, setShowNew] = useState(false);
  const [newType, setNewType] = useState<DocType>("evaluation");
  const [newTitle, setNewTitle] = useState(
    DOC_TEMPLATES[0].defaultTitle,
  );
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  // Delete gate: manager PIN panel, then a confirm step. The
  // verified PIN is held in component memory only.
  const [showPinPanel, setShowPinPanel] = useState(false);
  const [pinEntry, setPinEntry] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinChecking, setPinChecking] = useState(false);
  const [managerPin, setManagerPin] = useState("");
  const [authorizingManager, setAuthorizingManager] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setDocs(await listDocuments(user, patientApiId));
    } catch {
      setError("Couldn't load this patient's documents.");
    }
  }, [user, patientApiId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Switching patients closes any open editor, new-document form,
  // or delete gate, and forgets the verified manager PIN.
  useEffect(() => {
    setSelected(null);
    setEditorError("");
    setShowNew(false);
    setCreateError("");
    setShowPinPanel(false);
    setPinEntry("");
    setPinError("");
    setManagerPin("");
    setAuthorizingManager("");
    setConfirmingDelete(false);
    setDeleteError("");
    setError("");
  }, [patientApiId]);

  function openDocument(doc: ApiDocument) {
    const template = templateFor(doc.doc_type);
    setSelected(doc);
    setEditTitle(doc.title ?? "");
    setEditSections({ ...emptySections(template), ...doc.sections });
    setEditorError("");
    setShowPinPanel(false);
    setPinEntry("");
    setPinError("");
    setConfirmingDelete(false);
    setDeleteError("");
  }

  function closeEditor() {
    setSelected(null);
    setEditorError("");
    setShowPinPanel(false);
    setPinEntry("");
    setPinError("");
    setConfirmingDelete(false);
    setDeleteError("");
  }

  function pickNewType(type: DocType) {
    setNewType(type);
    setNewTitle(templateFor(type).defaultTitle);
    setCreateError("");
  }

  async function createDraft() {
    const template = templateFor(newType);
    setCreating(true);
    setCreateError("");
    try {
      const doc = await createDocument(user, {
        patient_id: patientApiId,
        doc_type: newType,
        title: newTitle.trim() ? newTitle.trim() : template.defaultTitle,
        sections: emptySections(template),
      });
      setShowNew(false);
      await load();
      openDocument(doc);
    } catch {
      setCreateError("Couldn't create the document.");
    } finally {
      setCreating(false);
    }
  }

  async function saveDraft() {
    if (!selected) return;
    setSaving(true);
    setEditorError("");
    try {
      const saved = await updateDocument(user, selected.id, {
        title: editTitle.trim() ? editTitle.trim() : null,
        sections: editSections,
      });
      setSelected(saved);
      setEditTitle(saved.title ?? "");
      setEditSections({
        ...emptySections(templateFor(saved.doc_type)),
        ...saved.sections,
      });
      await load();
    } catch (err) {
      if ((err as ApiRequestError | null)?.code === "DOCUMENT_FINALIZED") {
        setEditorError("This document is finalized and locked.");
      } else {
        setEditorError("Couldn't save the document.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function finalize() {
    if (!selected) return;
    if (
      !window.confirm(
        "Finalize this document? Finalized documents are locked and can't be edited.",
      )
    )
      return;
    setFinalizing(true);
    setEditorError("");
    try {
      const done = await finalizeDocument(user, selected.id);
      setSelected(done);
      setEditTitle(done.title ?? "");
      setEditSections({
        ...emptySections(templateFor(done.doc_type)),
        ...done.sections,
      });
      await load();
    } catch (err) {
      if ((err as ApiRequestError | null)?.code === "DOCUMENT_FINALIZED") {
        setEditorError("This document is finalized and locked.");
      } else {
        setEditorError("Couldn't finalize the document.");
      }
    } finally {
      setFinalizing(false);
    }
  }

  function startDelete() {
    setDeleteError("");
    if (managerPin) {
      setConfirmingDelete(true);
    } else {
      setPinEntry("");
      setPinError("");
      setShowPinPanel(true);
    }
  }

  async function submitPin(e: React.FormEvent) {
    e.preventDefault();
    const pin = pinEntry.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      setPinError("Incorrect PIN");
      return;
    }
    setPinChecking(true);
    setPinError("");
    try {
      const manager = await verifyManagerPin(user, pin);
      setManagerPin(pin);
      setAuthorizingManager(manager.name);
      setShowPinPanel(false);
      setPinEntry("");
      setConfirmingDelete(true);
    } catch (err) {
      setPinError(
        isPinRejection(err)
          ? "Incorrect PIN"
          : "Couldn't verify the PIN — check the connection and try again.",
      );
    } finally {
      setPinChecking(false);
    }
  }

  async function confirmDelete() {
    if (!selected) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteDocument(user, selected.id, managerPin);
      setConfirmingDelete(false);
      closeEditor();
      await load();
    } catch (err) {
      if (isPinRejection(err)) {
        setDeleteError("Incorrect PIN");
        setManagerPin("");
        setAuthorizingManager("");
        setConfirmingDelete(false);
        setShowPinPanel(true);
      } else {
        setDeleteError("Couldn't delete the document.");
      }
    } finally {
      setDeleting(false);
    }
  }

  const isFinalized = selected?.status === "finalized";
  const selectedTemplate = selected ? templateFor(selected.doc_type) : null;

  return (
    <article className="card">
      <strong>Clinical Documents</strong>
      <p className="card-meta">
        Evaluations, reassessments, and discharge summaries for this
        patient. Drafts can be edited; finalized documents are locked.
      </p>
      {error && <p className="pin-error">{error}</p>}
      <div className="card-list">
        {(docs ?? []).map((doc) => (
          <div key={doc.id} className="msg-bubble">
            <p className="card-meta">
              <span className="kind-badge">
                {doc.status === "finalized" ? "Finalized" : "Draft"}
              </span>{" "}
              <button
                type="button"
                className="linklike"
                onClick={() => openDocument(doc)}
              >
                <strong>
                  {doc.title || templateFor(doc.doc_type).defaultTitle}
                </strong>
              </button>
            </p>
            <p className="card-meta">
              {templateFor(doc.doc_type).label} · {doc.author_name} ·
              updated{" "}
              {new Date(doc.updated_at).toLocaleString("en-US")}
            </p>
          </div>
        ))}
        {docs !== null && docs.length === 0 && (
          <p className="section-note">No clinical documents yet.</p>
        )}
        {docs === null && !error && (
          <p className="section-note">Loading…</p>
        )}
      </div>

      <div className="profile-actions">
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => setShowNew((v) => !v)}
        >
          New document
        </button>
      </div>

      {showNew && (
        <div className="pin-panel">
          <label>
            Document type
            <select
              value={newType}
              onChange={(e) => pickNewType(e.target.value as DocType)}
            >
              {DOC_TEMPLATES.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Title
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
          </label>
          {createError && <p className="pin-error">{createError}</p>}
          <div className="profile-actions">
            <button
              className="btn btn-primary"
              type="button"
              disabled={creating}
              onClick={() => void createDraft()}
            >
              {creating ? "Creating…" : "Create draft"}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setShowNew(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {selected && selectedTemplate && (
        <div>
          <h3>
            {selectedTemplate.label} —{" "}
            {isFinalized ? "Finalized" : "Draft"}
          </h3>
          <p className="card-meta">
            {selected.author_name} · updated{" "}
            {new Date(selected.updated_at).toLocaleString("en-US")}
          </p>
          {isFinalized && (
            <p className="section-note">Finalized — locked</p>
          )}
          {editorError && <p className="pin-error">{editorError}</p>}
          <label>
            Title
            <input
              value={editTitle}
              disabled={isFinalized}
              onChange={(e) => setEditTitle(e.target.value)}
            />
          </label>
          {selectedTemplate.sections.map((section) => (
            <label key={section.key}>
              {section.label}
              <textarea
                rows={4}
                value={editSections[section.key] ?? ""}
                disabled={isFinalized}
                onChange={(e) =>
                  setEditSections((prev) => ({
                    ...prev,
                    [section.key]: e.target.value,
                  }))
                }
              />
            </label>
          ))}
          <div className="profile-actions">
            {!isFinalized && (
              <>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={saving}
                  onClick={() => void saveDraft()}
                >
                  {saving ? "Saving…" : "Save draft"}
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={finalizing}
                  onClick={() => void finalize()}
                >
                  {finalizing ? "Finalizing…" : "Finalize"}
                </button>
              </>
            )}
            <button
              className="btn btn-danger"
              type="button"
              onClick={startDelete}
            >
              Delete
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={closeEditor}
            >
              Close
            </button>
          </div>

          {showPinPanel && (
            <form className="pin-panel" onSubmit={submitPin}>
              <label>
                Manager PIN required to delete this document
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pinEntry}
                  onChange={(e) => setPinEntry(e.target.value)}
                  placeholder="PIN"
                />
              </label>
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
                  onClick={() => setShowPinPanel(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
          {confirmingDelete && (
            <div className="pin-panel">
              <p>
                Delete this document? It will be removed from the
                chart (soft delete).
              </p>
              {authorizingManager && (
                <p>Authorized by {authorizingManager} (manager PIN).</p>
              )}
              {deleteError && <p className="pin-error">{deleteError}</p>}
              <div className="profile-actions">
                <button
                  className="btn btn-danger"
                  type="button"
                  disabled={deleting}
                  onClick={() => void confirmDelete()}
                >
                  {deleting ? "Deleting…" : "Delete document"}
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {!confirmingDelete && deleteError && (
            <p className="pin-error">{deleteError}</p>
          )}
        </div>
      )}
    </article>
  );
}
