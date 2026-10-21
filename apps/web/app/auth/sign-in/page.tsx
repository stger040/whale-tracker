import { AuthForm } from '../AuthForm';
import { signInWithEmail } from '../actions';

export const metadata = { title: 'Sign in — $PLASHSPY' };

export default function SignInPage() {
  return <AuthForm mode="sign-in" action={signInWithEmail} />;
}
