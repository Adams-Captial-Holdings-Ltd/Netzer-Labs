import { useState, useEffect, useMemo } from 'preact/hooks';
import { api } from '../lib/api';
import { hasCapability } from '../lib/auth';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { Select } from '../components/Select';
import { Skeleton, SkeletonTableRow } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Modal, ConfirmDialog } from '../components/Modal';
import { toast } from '../components/Toast';

// ── Wave 4a MEMBERS API contract (src/adapters/dashboard/handler.ts) ─────────
// GET    /api/members            -> { count, members: Member[] }
// POST   /api/members/invite     { email, profileId } -> InviteResult (201)
// PATCH  /api/members/:id        { profileId }        -> { ok, profileId, downgraded, sessionsRevoked }
// POST   /api/members/:id/disable                     -> { ok, status:'disabled', sessionsRevoked }
// GET    /api/profiles           -> { profiles: ProfileDef[], capabilities: string[] }
// POST   /api/profiles           { id, capabilities } -> { ok, id, capabilities } (201)
// All writes require the members:write capability (admin/owner) server-side; the
// backend additionally bounds every granted profile to a subset of the actor's
// own caps, so a 403 'grant_exceeds_actor' is a legitimate (not a bug) response.

type MemberStatus = 'invited' | 'active' | 'disabled';

interface Member {
  userId: string;
  email: string;
  profileId: string;
  status: MemberStatus;
  invitedBy: string | null;
  invitedAt: string | null;
  activatedAt: string | null;
  lastLoginAt: string | null;
  disabledAt: string | null;
}

interface ProfileDef {
  id: string;
  kind: 'template' | 'custom';
  capabilities: string[];
}

interface ProfilesResponse {
  profiles: ProfileDef[];
  capabilities: string[];
}

interface InviteResult {
  ok: true;
  userId: string;
  email: string;
  profileId: string;
  status: 'invited';
  emailSent: boolean;
  emailSkipped?: string;
}

function statusBadge(status: MemberStatus) {
  if (status === 'active') return <Badge variant="success">Active</Badge>;
  if (status === 'invited') return <Badge variant="warning">Invited</Badge>;
  return <Badge variant="danger">Disabled</Badge>;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString();
}

function formatDate(iso: string | null): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleDateString();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Members() {
  // The page is readable by anyone the backend lets see /members (members:read,
  // which the /members route now requires). Mutations (invite, change-profile,
  // disable, custom-profile CRUD) require members:write and are re-checked
  // server-side, so canWrite gates on exactly that capability. owner holds it;
  // a members:read-only principal sees the page but none of the write controls.
  const canWrite = hasCapability('members:write');

  const [members, setMembers] = useState<Member[]>([]);
  const [profiles, setProfiles] = useState<ProfileDef[]>([]);
  const [allCapabilities, setAllCapabilities] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Invite modal state.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteProfileId, setInviteProfileId] = useState('');
  const [inviting, setInviting] = useState(false);

  // Change-profile modal state.
  const [editTarget, setEditTarget] = useState<Member | null>(null);
  const [editProfileId, setEditProfileId] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  // Disable confirm state.
  const [disableTarget, setDisableTarget] = useState<Member | null>(null);
  const [disabling, setDisabling] = useState(false);

  // Re-invite (per-row) state. Tracks the userId currently being re-invited so
  // only that row's button shows a spinner.
  const [reinvitingId, setReinvitingId] = useState<string | null>(null);

  // Custom-profile editor state.
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [profileEditId, setProfileEditId] = useState('');
  const [profileEditCaps, setProfileEditCaps] = useState<Set<string>>(new Set());
  const [savingProfileDef, setSavingProfileDef] = useState(false);
  // Tracks whether the editor is editing an existing custom profile (id locked)
  // or creating a new one (id editable).
  const [editingExisting, setEditingExisting] = useState(false);

  function loadMembers(signal?: AbortSignal) {
    return api
      .get<{ count: number; members: Member[] }>('/members', signal)
      .then((d) => setMembers(d.members))
      .catch((err) => {
        if ((err as Error)?.name === 'AbortError') return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load members');
      });
  }

  function loadProfiles(signal?: AbortSignal) {
    return api
      .get<ProfilesResponse>('/profiles', signal)
      .then((d) => {
        setProfiles(d.profiles);
        setAllCapabilities(d.capabilities);
      })
      .catch((err) => {
        if ((err as Error)?.name === 'AbortError') return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load profiles');
      });
  }

  // Runs both the members and profiles fetches together. Clears any prior error
  // at the start so a successful retry wipes the ErrorState. Also used as the
  // ErrorState retry handler (with no signal, so it cannot be aborted by an
  // unmount that already happened).
  function reloadAll(signal?: AbortSignal) {
    setLoading(true);
    setLoadError('');
    Promise.all([loadMembers(signal), loadProfiles(signal)]).finally(() => {
      if (!signal?.aborted) setLoading(false);
    });
  }

  useEffect(() => {
    const ac = new AbortController();
    reloadAll(ac.signal);
    return () => ac.abort();
  }, []);

  // Profile options for the invite / change-profile dropdowns. 'owner' is the
  // env break-glass profile and is never grantable, so it is filtered out.
  const profileOptions = useMemo(
    () =>
      profiles
        .filter((p) => p.id !== 'owner')
        .map((p) => ({
          value: p.id,
          label: `${p.id} (${p.kind}, ${p.capabilities.length} permissions)`,
        })),
    [profiles],
  );

  const customProfiles = useMemo(() => profiles.filter((p) => p.kind === 'custom'), [profiles]);
  const templateProfiles = useMemo(() => profiles.filter((p) => p.kind === 'template'), [profiles]);

  function openInvite() {
    setInviteEmail('');
    setInviteProfileId(profileOptions[0]?.value ?? '');
    setInviteOpen(true);
  }

  async function submitInvite() {
    const email = inviteEmail.trim();
    if (!EMAIL_RE.test(email)) {
      toast('Enter a valid email address', 'error');
      return;
    }
    if (!inviteProfileId) {
      toast('Pick a profile for the invitee', 'error');
      return;
    }
    setInviting(true);
    try {
      const res = await api.post<InviteResult>('/members/invite', {
        email,
        profileId: inviteProfileId,
      });
      if (res.emailSent) {
        toast(`Invite sent to ${res.email}`, 'success');
      } else {
        toast(
          `Member created. Invite email skipped${res.emailSkipped ? ` (${res.emailSkipped})` : ''}.`,
          'warning',
        );
      }
      setInviteOpen(false);
      await loadMembers();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to send invite', 'error');
    }
    setInviting(false);
  }

  function openEdit(m: Member) {
    setEditTarget(m);
    setEditProfileId(m.profileId);
  }

  async function submitEdit() {
    if (!editTarget) return;
    if (!editProfileId) {
      toast('Pick a profile', 'error');
      return;
    }
    if (editProfileId === editTarget.profileId) {
      toast('Profile unchanged', 'info');
      return;
    }
    setSavingProfile(true);
    try {
      const res = await api.patch<{ ok: true; downgraded: boolean; sessionsRevoked: number }>(
        `/members/${encodeURIComponent(editTarget.userId)}`,
        { profileId: editProfileId },
      );
      if (res.downgraded && res.sessionsRevoked > 0) {
        toast(
          `Profile changed. Downgrade revoked ${res.sessionsRevoked} live session${res.sessionsRevoked === 1 ? '' : 's'}.`,
          'success',
        );
      } else {
        toast('Profile changed', 'success');
      }
      setEditTarget(null);
      await loadMembers();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to change profile', 'error');
    }
    setSavingProfile(false);
  }

  async function confirmDisable() {
    if (!disableTarget) return;
    setDisabling(true);
    try {
      const res = await api.post<{ ok: true; sessionsRevoked: number }>(
        `/members/${encodeURIComponent(disableTarget.userId)}/disable`,
      );
      toast(
        `${disableTarget.email} disabled. Revoked ${res.sessionsRevoked} session${res.sessionsRevoked === 1 ? '' : 's'}.`,
        'success',
      );
      setDisableTarget(null);
      await loadMembers();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to disable member', 'error');
    }
    setDisabling(false);
  }

  // Re-invite a disabled member. The backend POST /members/invite route detects
  // an existing (disabled) email, reuses the userId, flips the status back to
  // invited, and mints a fresh accept link, so we reuse the same endpoint with
  // the member's existing email + profile. No dedicated reinvite route exists or
  // is needed.
  async function reinvite(m: Member) {
    setReinvitingId(m.userId);
    try {
      const res = await api.post<InviteResult>('/members/invite', {
        email: m.email,
        profileId: m.profileId,
      });
      if (res.emailSent) {
        toast(`Invite re-sent to ${res.email}`, 'success');
      } else {
        toast(
          `Member re-invited. Invite email skipped${res.emailSkipped ? ` (${res.emailSkipped})` : ''}.`,
          'warning',
        );
      }
      await loadMembers();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to re-invite member', 'error');
    }
    setReinvitingId(null);
  }

  function openNewProfile() {
    setEditingExisting(false);
    setProfileEditId('');
    setProfileEditCaps(new Set());
    setProfileEditorOpen(true);
  }

  function openEditProfile(p: ProfileDef) {
    setEditingExisting(true);
    setProfileEditId(p.id);
    setProfileEditCaps(new Set(p.capabilities));
    setProfileEditorOpen(true);
  }

  function toggleCap(cap: string) {
    setProfileEditCaps((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  }

  async function saveProfileDef() {
    const id = profileEditId.trim().replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) {
      toast('Profile id must be alphanumeric (with - or _)', 'error');
      return;
    }
    setSavingProfileDef(true);
    try {
      // POST /profiles upserts: same endpoint creates a new profile or replaces
      // an existing custom one's capability set.
      await api.post<{ ok: true; id: string; capabilities: string[] }>('/profiles', {
        id,
        capabilities: [...profileEditCaps],
      });
      toast(editingExisting ? `Profile "${id}" updated` : `Profile "${id}" created`, 'success');
      setProfileEditorOpen(false);
      await loadProfiles();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save profile', 'error');
    }
    setSavingProfileDef(false);
  }

  return (
    <div>
      <div data-tour="members-invite" class="flex items-center justify-between mb-6">
        <div>
          <h1 data-tour="members-title" class="text-display-sm text-primary font-bold">Team</h1>
          <p class="text-body-sm text-secondary mt-1">
            Manage members, invites, and permission profiles. Invites and profile changes are
            admin-only and re-checked on the server.
          </p>
        </div>
        {canWrite && (
          <Button onClick={openInvite} disabled={loading}>
            Invite member
          </Button>
        )}
      </div>

      {!loading && loadError && (
        <ErrorState
          title="Could not load team"
          message={`${loadError}. This is an error, not an empty team. Check your connection or permissions and try again.`}
          onRetry={() => reloadAll()}
          class="mb-6"
        />
      )}

      {/* The members table + profiles are hidden while the load is errored so the
          ErrorState above is the only thing shown for a real failure (not an
          empty table that reads like "no members"). */}
      {!loadError && (
        <>
      {/* ── Members table ──────────────────────────────────────────────────── */}
      <section data-tour="members-table" class="mb-10">
        <h2 class="text-heading-sm font-semibold text-secondary mb-4 uppercase tracking-wider">
          Members
        </h2>
        <div class="bg-surface border border-border rounded-xl overflow-hidden">
          <div class="overflow-x-auto"><table class="w-full text-left">
            <thead>
              <tr class="border-b border-border bg-surface-elevated">
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">
                  Email
                </th>
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">
                  Role
                </th>
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">
                  Status
                </th>
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">
                  Last login
                </th>
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">
                  Invited by
                </th>
                {canWrite && <th class="px-4 py-3"></th>}
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              {loading
                ? Array.from({ length: 4 }).map((_, i) => (
                    <SkeletonTableRow key={i} cols={canWrite ? 6 : 5} />
                  ))
                : members.map((m) => (
                    <tr key={m.userId} class="hover:bg-surface-hover transition-colors">
                      <td class="px-4 py-3 text-body-sm font-medium text-primary break-all">
                        {m.email}
                      </td>
                      <td class="px-4 py-3 text-body-sm">
                        <span class="font-mono text-secondary">{m.profileId}</span>
                      </td>
                      <td class="px-4 py-3">{statusBadge(m.status)}</td>
                      <td
                        class="px-4 py-3 text-body-sm text-secondary"
                        title={formatTimestamp(m.lastLoginAt)}
                      >
                        {formatDate(m.lastLoginAt)}
                      </td>
                      <td class="px-4 py-3 text-body-sm text-secondary">{m.invitedBy ?? '--'}</td>
                      {canWrite && (
                        <td class="px-4 py-3">
                          <div class="flex items-center justify-end gap-3">
                            <button
                              onClick={() => openEdit(m)}
                              class="text-caption text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
                            >
                              Change role
                            </button>
                            {m.status !== 'disabled' ? (
                              <button
                                onClick={() => setDisableTarget(m)}
                                class="text-caption text-danger hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger rounded"
                              >
                                Disable
                              </button>
                            ) : (
                              <button
                                onClick={() => reinvite(m)}
                                disabled={reinvitingId === m.userId}
                                class="text-caption text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                {reinvitingId === m.userId ? 'Re-inviting…' : 'Re-invite'}
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
            </tbody>
          </table></div>
          {!loading && members.length === 0 && !loadError && (
            <EmptyState
              title="No members yet"
              description={
                canWrite
                  ? 'Invite a teammate by email to give them dashboard access.'
                  : 'Members will appear here once they are invited.'
              }
              action={canWrite ? <Button onClick={openInvite}>Invite member</Button> : undefined}
            />
          )}
        </div>
      </section>

      {/* ── Permission profiles ────────────────────────────────────────────── */}
      <section data-tour="members-profiles">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-heading-sm font-semibold text-secondary uppercase tracking-wider">
            Permission profiles
          </h2>
          {canWrite && (
            <Button variant="secondary" size="sm" onClick={openNewProfile} disabled={loading}>
              New custom profile
            </Button>
          )}
        </div>

        {loading ? (
          <Skeleton height="120px" width="100%" />
        ) : (
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...templateProfiles, ...customProfiles].map((p) => (
              <div key={p.id} class="bg-surface border border-border rounded-xl p-4">
                <div class="flex items-center justify-between mb-2">
                  <span class="font-mono text-body-sm font-semibold text-primary">{p.id}</span>
                  <Badge variant={p.kind === 'custom' ? 'info' : 'muted'}>{p.kind}</Badge>
                </div>
                <div class="flex flex-wrap gap-1.5 min-h-[28px]">
                  {p.capabilities.length === 0 ? (
                    <span class="text-caption text-muted">No capabilities</span>
                  ) : (
                    p.capabilities.map((cap) => (
                      <span
                        key={cap}
                        class="text-overline font-mono text-secondary bg-surface-elevated border border-border rounded px-1.5 py-0.5"
                      >
                        {cap}
                      </span>
                    ))
                  )}
                </div>
                {canWrite && p.kind === 'custom' && (
                  <div class="mt-3 pt-3 border-t border-border">
                    <button
                      onClick={() => openEditProfile(p)}
                      class="text-caption text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
                    >
                      Edit capabilities
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p class="text-caption text-muted mt-4">
          Template profiles are built-in and read-only. Custom profiles are capped to the
          capabilities you yourself hold, enforced by the server.
        </p>
      </section>
        </>
      )}

      {/* ── Invite modal ───────────────────────────────────────────────────── */}
      <Modal open={inviteOpen} onClose={() => setInviteOpen(false)} title="Invite member">
        <div class="space-y-4">
          <div>
            <label class="block text-caption text-secondary font-medium mb-1">Email</label>
            <input
              type="email"
              value={inviteEmail}
              onInput={(e) => setInviteEmail((e.target as HTMLInputElement).value)}
              placeholder="teammate@example.com"
              autoFocus
              autocomplete="off"
              class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm text-primary placeholder:text-muted outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <div>
            <label class="block text-caption text-secondary font-medium mb-1">Role</label>
            <Select
              value={inviteProfileId}
              onChange={setInviteProfileId}
              options={profileOptions}
              placeholder="Select a profile"
              class="w-full"
            />
          </div>
          <p class="text-caption text-muted">
            We email the invitee a single-use accept link (valid 72 hours). You can only grant a
            profile whose capabilities are a subset of your own.
          </p>
          <div class="flex gap-3 justify-end">
            <Button variant="secondary" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button loading={inviting} onClick={submitInvite}>
              Send invite
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Change-profile modal ───────────────────────────────────────────── */}
      <Modal open={editTarget !== null} onClose={() => setEditTarget(null)} title="Change role">
        {editTarget && (
          <div class="space-y-4">
            <p class="text-body-sm text-secondary">
              Changing the role for <span class="font-medium text-primary">{editTarget.email}</span>.
              A downgrade revokes their live sessions immediately.
            </p>
            <div>
              <label class="block text-caption text-secondary font-medium mb-1">Role</label>
              <Select
                value={editProfileId}
                onChange={setEditProfileId}
                options={profileOptions}
                placeholder="Select a profile"
                class="w-full"
              />
            </div>
            <div class="flex gap-3 justify-end">
              <Button variant="secondary" onClick={() => setEditTarget(null)}>
                Cancel
              </Button>
              <Button loading={savingProfile} onClick={submitEdit}>
                Save role
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Custom-profile editor ──────────────────────────────────────────── */}
      <Modal
        open={profileEditorOpen}
        onClose={() => setProfileEditorOpen(false)}
        title={editingExisting ? 'Edit custom profile' : 'New custom profile'}
        size="lg"
      >
        <div class="space-y-4">
          <div>
            <label class="block text-caption text-secondary font-medium mb-1">Profile id</label>
            <input
              value={profileEditId}
              onInput={(e) => setProfileEditId((e.target as HTMLInputElement).value)}
              placeholder="e.g. cost-analyst"
              disabled={editingExisting}
              autocomplete="off"
              class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm font-mono text-primary placeholder:text-muted placeholder:font-sans outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-60 disabled:cursor-not-allowed"
            />
            {!editingExisting && (
              <p class="text-overline text-muted mt-1">
                Letters, numbers, hyphen, underscore. Cannot match a built-in profile name.
              </p>
            )}
          </div>
          <div>
            <label class="block text-caption text-secondary font-medium mb-2">Capabilities</label>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-1">
              {allCapabilities.map((cap) => (
                <label
                  key={cap}
                  class="flex items-center gap-2 cursor-pointer rounded-lg px-2 py-1.5 hover:bg-surface-hover transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={profileEditCaps.has(cap)}
                    onChange={() => toggleCap(cap)}
                    class="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                  />
                  <span class="text-body-sm font-mono text-secondary">{cap}</span>
                </label>
              ))}
            </div>
            <p class="text-caption text-muted mt-2">
              {profileEditCaps.size} selected. The server rejects any capability you do not hold.
            </p>
          </div>
          <div class="flex gap-3 justify-end">
            <Button variant="secondary" onClick={() => setProfileEditorOpen(false)}>
              Cancel
            </Button>
            <Button loading={savingProfileDef} onClick={saveProfileDef}>
              {editingExisting ? 'Save profile' : 'Create profile'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Disable confirm (destructive, gated) ───────────────────────────── */}
      <ConfirmDialog
        open={disableTarget !== null}
        onClose={() => setDisableTarget(null)}
        onConfirm={confirmDisable}
        title="Disable member"
        message={
          disableTarget
            ? `Disable ${disableTarget.email}? This revokes all of their live sessions immediately. You can re-invite them later.`
            : ''
        }
        confirmLabel="Disable member"
        danger
        loading={disabling}
      />
    </div>
  );
}
