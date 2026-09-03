"use client";

import { useActionState, useState } from "react";
import { saveStaff, type StaffState } from "./actions";
import { ROLES, ROLE_LABELS, isRole } from "@/lib/permissions";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/pin";

const input = "h-10 w-full sheet border border-char-300 px-2 text-sm";

/**
 * Add or edit a staff account.
 *
 * The PIN is how this person signs in — it is the only thing they type at the
 * till, so it identifies them as well as authorises them. No two people may
 * share one.
 *
 * Editing leaves the PIN field blank — an empty PIN means "leave it alone",
 * because a manager tidying up somebody's name should not silently reset the
 * PIN they use a hundred times a day.
 */
export function StaffForm({
  existing,
  inline = false,
}: {
  existing?: { id: string; name: string; staffCode: string; role: string; active: boolean };
  inline?: boolean;
}) {
  const [state, action, pending] = useActionState<StaffState, FormData>(saveStaff, {});
  const [open, setOpen] = useState(!inline);

  if (inline && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="sheet px-2 py-1 text-xs font-medium text-char-600 hover:bg-char-100"
      >
        Edit
      </button>
    );
  }

  const body = (
    <form action={action} className="grid grid-cols-1 gap-3 md:grid-cols-5">
      {existing && <input type="hidden" name="id" value={existing.id} />}

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-char-600">Name</span>
        <input name="name" defaultValue={existing?.name} required className={input} />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-char-600">
          Employee number
        </span>
        <input
          name="staffCode"
          defaultValue={existing?.staffCode}
          inputMode="numeric"
          required
          className={`tabular ${input}`}
        />
        <span className="mt-1 block text-[11px] text-char-500">For rotas and reports</span>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-char-600">Role</span>
        <select
          name="role"
          defaultValue={existing && isRole(existing.role) ? existing.role : "CASHIER"}
          className={input}
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-char-600">
          Sign-in PIN{" "}
          {existing && <span className="text-char-400">(blank keeps the current one)</span>}
        </span>
        <input
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          minLength={PIN_MIN_LENGTH}
          maxLength={PIN_MAX_LENGTH}
          placeholder={`${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} digits`}
          className={input}
        />
        <span className="mt-1 block text-[11px] text-char-500">
          The only thing they type to sign in. Must be unique.
        </span>
      </label>

      <div className="flex items-end gap-3">
        <label className="flex h-10 items-center gap-2 text-sm text-char-700">
          <input
            type="checkbox"
            name="active"
            defaultChecked={existing?.active ?? true}
            className="h-4 w-4 rounded border-char-300"
          />
          Active
        </label>

        <button
          type="submit"
          disabled={pending}
          className="h-10 sheet bg-brass-500 px-4 text-sm font-semibold text-white hover:bg-brass-400 disabled:opacity-50"
        >
          {pending ? "Saving…" : existing ? "Save" : "Add"}
        </button>

        {inline && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="h-10 sheet px-3 text-sm text-char-600 hover:bg-char-100"
          >
            Close
          </button>
        )}
      </div>

      {(state.error || state.success) && (
        <p
          className={`md:col-span-5 text-sm ${
            state.error ? "text-meat-700" : "text-emerald-700"
          }`}
        >
          {state.error ?? state.success}
        </p>
      )}
    </form>
  );

  if (inline) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-3xl sheet bg-char-50 p-5 text-left shadow-2xl">
          <h2 className="mb-4 text-base font-semibold text-char-900">Edit {existing?.name}</h2>
          {body}
        </div>
      </div>
    );
  }

  return (
    <section className="sheet border border-char-200 bg-char-50 p-4">
      <h2 className="mb-3 text-sm font-semibold text-char-800">Add a staff member</h2>
      {body}
    </section>
  );
}
