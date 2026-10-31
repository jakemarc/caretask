import { US_STATES } from "../lib/usStates";

// State dropdown for the patient forms. Values are 2-letter codes,
// matching what the address autocomplete fills and what the API stores.
// If a record somehow carries a value outside the list, it is kept as
// an extra option so an edit never silently drops it.
export default function StateSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const known = US_STATES.some((s) => s.code === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select state</option>
      {!known && value !== "" && <option value={value}>{value}</option>}
      {US_STATES.map((s) => (
        <option key={s.code} value={s.code}>
          {s.code} — {s.name}
        </option>
      ))}
    </select>
  );
}
