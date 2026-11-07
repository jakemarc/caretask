// Settings card: Home & Office addresses (deploy-40). The
// clinician's own two addresses, written self-service through
// PUT /users/me/addresses. Home rides the staff profile address
// (street/city/state/zip); office has its own office_* fields.
// The Mileage page uses the pair as the day's fixed bookends —
// before this card there was nowhere in Settings to set either
// one, so the bookends silently never resolved for clinicians
// whose profile/agency addresses were blank.
import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import AddressAutocomplete from "./AddressAutocomplete";
import StateSelect from "./StateSelect";
import {
  updateMyAddresses,
  type ApiUser,
  type MyAddressesInput,
} from "../lib/patientApi";
import { refreshMyStaff, useMyStaff } from "../lib/useMyRole";

interface Props {
  user: User;
  apiConnected: boolean;
}

interface Addr {
  street: string;
  city: string;
  state: string;
  zip: string;
}

const blankAddr = (): Addr => ({ street: "", city: "", state: "", zip: "" });

function fromRecord(rec: ApiUser, office: boolean): Addr {
  return office
    ? {
        street: rec.office_street ?? "",
        city: rec.office_city ?? "",
        state: rec.office_state ?? "",
        zip: rec.office_zip ?? "",
      }
    : {
        street: rec.street ?? "",
        city: rec.city ?? "",
        state: rec.state ?? "",
        zip: rec.zip ?? "",
      };
}

function isEmpty(a: Addr): boolean {
  return !a.street.trim() && !a.city.trim() && !a.state.trim() && !a.zip.trim();
}

function AddressFields({
  value,
  onChange,
}: {
  value: Addr;
  onChange: (a: Addr) => void;
}) {
  const set = (patch: Partial<Addr>) => onChange({ ...value, ...patch });
  return (
    <>
      <div className="form-field">
        <span>Street</span>
        <AddressAutocomplete
          value={value.street}
          onChange={(v) => set({ street: v })}
          onSelectAddress={(a) =>
            onChange({
              street: a.street,
              city: a.city,
              state: a.state,
              zip: a.postal_code,
            })
          }
        />
      </div>
      <label>
        City
        <input value={value.city} onChange={(e) => set({ city: e.target.value })} />
      </label>
      <div className="form-row">
        <label>
          State
          <StateSelect value={value.state} onChange={(v) => set({ state: v })} />
        </label>
        <label>
          ZIP
          <input value={value.zip} onChange={(e) => set({ zip: e.target.value })} />
        </label>
      </div>
    </>
  );
}

export function HomeOfficeCard({ user, apiConnected }: Props) {
  const me = useMyStaff(user);
  const [saved, setSaved] = useState<ApiUser | null>(null);
  const [home, setHome] = useState<Addr>(blankAddr());
  const [office, setOffice] = useState<Addr>(blankAddr());
  const [busy, setBusy] = useState<"home" | "office" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const initialized = useRef(false);

  // Prefill once, when the staff record first arrives.
  useEffect(() => {
    if (!me || initialized.current) return;
    initialized.current = true;
    setSaved(me);
    setHome(fromRecord(me, false));
    setOffice(fromRecord(me, true));
  }, [me]);

  if (!apiConnected) {
    return (
      <article className="card">
        <strong>Home &amp; Office</strong>
        <p>
          Your home and office addresses need the API — they can't load while
          the API is unreachable.
        </p>
      </article>
    );
  }

  if (me === undefined) {
    return (
      <article className="card">
        <div className="card-top">
          <strong>Home &amp; Office</strong>
        </div>
        <p className="section-note">Loading…</p>
      </article>
    );
  }

  if (me === null) {
    return (
      <article className="card">
        <div className="card-top">
          <strong>Home &amp; Office</strong>
        </div>
        <p>
          Addresses live on your staff record — once you have one, you can set
          your home and office addresses here.
        </p>
      </article>
    );
  }

  const save = async (which: "home" | "office") => {
    setBusy(which);
    setError("");
    setNotice("");
    try {
      const a = which === "home" ? home : office;
      const input: MyAddressesInput =
        which === "home"
          ? { street: a.street, city: a.city, state: a.state, zip: a.zip }
          : {
              office_street: a.street,
              office_city: a.city,
              office_state: a.state,
              office_zip: a.zip,
            };
      const updated = await updateMyAddresses(user, input);
      // Refresh the shared staff record so the Mileage page picks
      // the new bookends up without a reload.
      await refreshMyStaff(user);
      setSaved(updated);
      if (which === "home") setHome(fromRecord(updated, false));
      else setOffice(fromRecord(updated, true));
      setNotice(which === "home" ? "Home address saved." : "Office address saved.");
    } catch {
      setError(
        which === "home"
          ? "Couldn't save your home address."
          : "Couldn't save your office address.",
      );
    } finally {
      setBusy(null);
    }
  };

  const homeOnFile = saved ? !isEmpty(fromRecord(saved, false)) : false;
  const officeOnFile = saved ? !isEmpty(fromRecord(saved, true)) : false;

  return (
    <article className="card">
      <div className="card-top">
        <strong>Home &amp; Office</strong>
      </div>
      <p>
        Your home and office addresses. The Mileage page uses these as the
        day's bookends — legs between home and office count as personal
        (commute) miles, and the stops between them are billable. Your own
        office address is used before your agency's address.
      </p>
      <form
        className="add-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save("home");
        }}
      >
        <h3>Home address</h3>
        <AddressFields value={home} onChange={setHome} />
        <div className="flag-actions">
          <button type="submit" className="btn btn-primary" disabled={busy !== null}>
            {busy === "home"
              ? "Saving…"
              : homeOnFile
                ? "Save home address"
                : "Add home address"}
          </button>
        </div>
      </form>
      <form
        className="add-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save("office");
        }}
      >
        <h3>Office address</h3>
        <AddressFields value={office} onChange={setOffice} />
        <div className="flag-actions">
          <button type="submit" className="btn btn-primary" disabled={busy !== null}>
            {busy === "office"
              ? "Saving…"
              : officeOnFile
                ? "Save office address"
                : "Add office address"}
          </button>
        </div>
      </form>
      {notice && <p className="section-note">{notice}</p>}
      {error && <p className="pin-error">{error}</p>}
    </article>
  );
}
