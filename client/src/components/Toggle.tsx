interface ToggleProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}

/** Accessible toggle switch — a checkbox styled as a switch, never color alone (has a real label). */
export function Toggle({ checked, disabled, onChange, label }: ToggleProps) {
  return (
    <label className="switch" title={label}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" />
    </label>
  );
}
