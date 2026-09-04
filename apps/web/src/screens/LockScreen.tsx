/**
 * The passcode.
 *
 * Roam's API used to answer anybody who found its address, which meant the
 * family's home, the children's names and every rating they had ever given were
 * a URL away. This is the door that closed it.
 *
 * One field, because V1 is one household (Requirements §3) — there is nobody to
 * pick between yet, so asking for a name as well would be a question with one
 * answer. It is entered once per device and lasts ninety days.
 */

import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, spacing, TARGET, type } from '../theme';
import { Button } from '../components/ui';
import { Icon } from '../components/Icon';
import { Wordmark } from '../components/Wordmark';
import { useViewport } from '../hooks/useViewport';
import { api, ApiError } from '../api';

export function LockScreen({ onIn, configured = true, notice = null }: {
  onIn: () => void;
  configured?: boolean;
  /** Why they are looking at this rather than the app — a link that had been used, say. */
  notice?: string | null;
}) {
  const { width } = useViewport();
  const [passcode, setPasscode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(notice);
  // Somebody whose ninety days ran out, or who has a new phone: they never had
  // a passcode and are not going to be given one, so the way back in is a link.
  const [asking, setAsking] = useState(Boolean(notice));
  const [email, setEmail] = useState('');
  const [asked, setAsked] = useState<string | null>(null);

  const askForLink = async () => {
    if (!email.includes('@') || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.requestSignInLink(email.trim());
      setAsked(r.message);
    } catch (err: any) {
      setProblem(err instanceof ApiError ? err.message : 'Could not reach Roam. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!passcode.trim() || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api.signIn(passcode.trim());
      setPasscode('');
      onIn();
    } catch (err: any) {
      // The API says how long a locked-out device has to wait; anything else is
      // simply wrong, and it does not say which part was wrong.
      setProblem(err instanceof ApiError ? err.message : 'Could not reach Roam. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  // The API has no passcode set at all: nothing to type, and the owner is the
  // only person who can fix it. Say so plainly rather than failing to sign in.
  if (!configured) {
    return (
      <View style={styles.root}>
        <View style={[styles.card, { maxWidth: Math.min(380, width - spacing.xl * 2) }]}>
          <Wordmark height={40} ground={colors.surface} />
          <View style={styles.lock}><Icon name="locked" size={20} color={colors.inkMuted} /></View>
          <Text style={type.body}>This Roam has no passcode set yet.</Text>
          <Text style={type.small}>
            Nothing is being served until there is one. Add <Text style={styles.mono}>ROAM_PASSCODE</Text> in Doppler and redeploy the API.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={[styles.card, { maxWidth: Math.min(380, width - spacing.xl * 2) }]}>
        <Wordmark height={40} ground={colors.surface} />
        <Text style={type.small}>Remember every place you love</Text>

        <View style={styles.lock}><Icon name="locked" size={20} color={colors.inkMuted} /></View>

        <Text style={type.body}>Enter the household passcode</Text>
        <TextInput
          value={passcode}
          onChangeText={(t) => { setPasscode(t); if (problem) setProblem(null); }}
          onSubmitEditing={submit}
          placeholder="Passcode"
          placeholderTextColor={colors.inkFaint}
          secureTextEntry
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          // So a password manager offers to keep it, rather than the family
          // keeping it somewhere worse.
          {...(Platform.OS === 'web' ? { autoComplete: 'current-password' as const } : {})}
          returnKeyType="go"
          accessibilityLabel="Household passcode"
          style={[styles.input, problem ? styles.inputWrong : null]}
        />

        {problem ? (
          <View style={styles.problem}>
            <Icon name="allergen" size={14} color={colors.overrun} />
            <Text style={[type.small, { color: colors.overrun, flex: 1 }]}>{problem}</Text>
          </View>
        ) : null}

        <Button label="Open Roam" onPress={submit} loading={busy} disabled={!passcode.trim()} style={{ alignSelf: 'stretch' }} />
        <Text style={type.tiny}>This device stays signed in for 90 days. You can sign it out from Settings.</Text>

        {/* The other way in. Everybody except the owner signs in by link, so
            this is not a fallback for them — it is their front door. */}
        <View style={styles.other}>
          {asked ? (
            <View style={styles.problem}>
              <Icon name="mail" size={14} color={colors.icon} />
              <Text style={[type.small, { flex: 1 }]}>{asked}</Text>
            </View>
          ) : asking ? (
            <>
              <Text style={type.small}>Roam will e-mail you a link.</Text>
              <TextInput
                value={email}
                onChangeText={(t) => { setEmail(t); if (problem) setProblem(null); }}
                onSubmitEditing={askForLink}
                placeholder="you@example.com"
                placeholderTextColor={colors.inkFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                inputMode="email"
                returnKeyType="go"
                accessibilityLabel="Your e-mail address"
                style={styles.input}
              />
              <Button
                label="E-mail me a link"
                icon="send"
                kind="secondary"
                onPress={askForLink}
                loading={busy}
                disabled={!email.includes('@')}
                style={{ alignSelf: 'stretch' }}
              />
            </>
          ) : (
            <Pressable onPress={() => setAsking(true)} accessibilityRole="button">
              <Text style={[type.small, styles.quiet]}>I sign in with a link instead</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, padding: spacing.xl },
  card: {
    width: '100%', alignItems: 'center', gap: spacing.md,
    padding: spacing.xl, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
  },
  lock: {
    width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.well, marginTop: spacing.sm,
  },
  input: {
    alignSelf: 'stretch', minHeight: TARGET, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, fontSize: 15, color: colors.ink,
    textAlign: 'center',
  },
  inputWrong: { borderColor: colors.overrun },
  problem: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, alignSelf: 'stretch' },
  mono: { fontFamily: Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined, color: colors.ink },
  other: {
    alignSelf: 'stretch', alignItems: 'center', gap: spacing.sm,
    marginTop: spacing.sm, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.line,
  },
  quiet: { color: colors.inkMuted, textDecorationLine: 'underline' },
});
