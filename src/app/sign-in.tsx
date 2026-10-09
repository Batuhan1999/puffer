// Sign in to, or create, the account on the relay (src/auth.ts). Signing in lets Puffer register this iPhone with the
// relay so agents can connect. Presented as a sheet from Agents.
import { Button, Picker, SecureField, Section, Text, TextField } from '@expo/ui/swift-ui';
import {
  autocorrectionDisabled,
  disabled,
  keyboardType,
  onSubmit,
  pickerStyle,
  submitLabel,
  tag,
  textContentType,
  textInputAutocapitalization,
} from '@expo/ui/swift-ui/modifiers';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';

import { signIn, signUp } from '@/auth';
import { notesTint } from '@/ui/colors';
import { ScreenList } from '@/ui/screen';
import { alertError } from '@/ui/states';

type Mode = 'signIn' | 'signUp';

/** Better Auth's default minimum. */
const MIN_PASSWORD = 8;

export default function SignInScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('signIn');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const creating = mode === 'signUp';
  const ready = /^\S+@\S+\.\S+$/.test(email.trim()) && password.length >= MIN_PASSWORD && (!creating || name.trim() !== '');

  // A new password field for each mode (its content type differs), so the typed password goes with it.
  const switchMode = (next: Mode) => {
    setMode(next);
    setPassword('');
  };

  const submit = () => {
    if (!ready || busy) return;
    setBusy(true);
    const work = creating ? signUp(name.trim(), email.trim(), password) : signIn(email.trim(), password);
    work.then(
      () => router.back(),
      (e) => {
        setBusy(false);
        alertError(creating ? 'Could Not Create Account' : 'Could Not Sign In')(e);
      },
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: creating ? 'Create Account' : 'Sign In' }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button tintColor={notesTint} onPress={() => router.back()}>
          Cancel
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScreenList>
        <Section>
          <Picker<Mode> selection={mode} onSelectionChange={switchMode} modifiers={[pickerStyle('segmented')]}>
            <Text modifiers={[tag('signIn')]}>Sign In</Text>
            <Text modifiers={[tag('signUp')]}>Create Account</Text>
          </Picker>
        </Section>

        <Section
          footer={
            <Text>
              {creating
                ? `Use at least ${MIN_PASSWORD} characters. Your account lets Puffer connect this iPhone to the relay, so agents can reach your notes once you approve them.`
                : 'Puffer connects this iPhone to the relay once you sign in.'}
            </Text>
          }
        >
          {creating ? (
            <TextField
              placeholder="Name"
              onValueChange={setName}
              modifiers={[textContentType('name'), textInputAutocapitalization('words'), submitLabel('next')]}
            />
          ) : null}
          <TextField
            placeholder="Email"
            onValueChange={setEmail}
            modifiers={[
              textContentType(creating ? 'emailAddress' : 'username'),
              keyboardType('email-address'),
              textInputAutocapitalization('never'),
              autocorrectionDisabled(),
              submitLabel('next'),
            ]}
          />
          <SecureField
            key={mode}
            placeholder="Password"
            onValueChange={setPassword}
            modifiers={[textContentType(creating ? 'newPassword' : 'password'), submitLabel('go'), onSubmit(submit)]}
          />
        </Section>

        <Section>
          <Button
            label={creating ? 'Create Account' : 'Sign In'}
            systemImage={creating ? 'person.crop.circle.badge.plus' : 'person.crop.circle'}
            onPress={submit}
            modifiers={[disabled(!ready || busy)]}
          />
        </Section>
      </ScreenList>
    </>
  );
}
