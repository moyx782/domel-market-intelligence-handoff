import {useState} from 'react';
import {ArrowRight,FlaskConical,ShieldCheck} from 'lucide-react';
import {supabase} from './data';
import {authRedirect,passwordError} from './auth-flow.mjs';
import {useI18n} from './i18n';
import LanguageSwitch from './LanguageSwitch';

export default function AuthPanel({setup,authenticated,onDone,onDemo}:{setup:boolean;authenticated:boolean;onDone:()=>void;onDemo:()=>void}) {
 const {t}=useI18n();
 const [mode,setMode]=useState<'login'|'reset'>('login');
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 async function submit(e:React.FormEvent) {
  e.preventDefault();setError('');setNotice('');setBusy(true);
  try {
   if(!supabase)throw Error(t('Live authentication is not connected. Add your Supabase public configuration and rebuild. Demo access does not authenticate an account.'));
   if(setup){
    if(!authenticated)throw Error(t('This link has expired or is invalid. Ask your administrator for a new invitation or request another password reset.'));
    const validation=passwordError(password,confirm);if(validation)throw Error(validation);
    const {error}=await supabase.auth.updateUser({password});if(error)throw error;
    setPassword('');setConfirm('');window.history.replaceState({},'',window.location.pathname);onDone();
   }else if(mode==='reset'){
    const {error}=await supabase.auth.resetPasswordForEmail(email,{redirectTo:authRedirect(window.location.origin)});if(error)throw error;
    setNotice(t('If this address is eligible, you will receive a reset link. Check your inbox and spam folder.'));
   }else{
    const {error}=await supabase.auth.signInWithPassword({email,password});if(error)throw error;setPassword('');
   }
  }catch(e){setError(e instanceof Error?e.message:t('Authentication failed. Try again.'));}finally{setBusy(false);}
 }
 return <div className="login"><section className="login-form"><div className="login-lang"><LanguageSwitch/></div><div className="brand"><div className="brand-logo">d<span/></div><div><strong>Domel</strong><small>{t('MARKET INTELLIGENCE')}</small></div></div>
 <div className="eyebrow">{t('RESEARCH WITH CONFIDENCE')}</div><h1>{setup?t('Set your password.'):mode==='reset'?t('Reset your password.'):t('Welcome back.')}</h1>
 <p>{setup?t('Complete your invitation or recovery using a new password.'):mode==='reset'?t('Request a secure email link for your individual account.'):t('Sign in to your market intelligence workspace.')}</p>
 {!supabase&&<div role="status" className="alert">{t('Live authentication is awaiting Supabase configuration.')}</div>}
 {error&&<div role="alert" className="alert error">{error}</div>}{notice&&<div role="status" className="alert success">{notice}</div>}
 {setup&&!authenticated&&<div role="alert" className="alert error">{t('No valid authenticated session was found for this link.')}</div>}
 <form onSubmit={submit}>
 {!setup&&<label>{t('Email address')}<input type="email" required autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></label>}
 {(setup||mode==='login')&&<label>{setup?t('New password'):t('Password')}<input type="password" required minLength={setup?12:undefined} autoComplete={setup?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)}/></label>}
 {setup&&<><label>{t('Confirm password')}<input type="password" required minLength={12} autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)}/></label><p className="small">{t('Use at least 12 characters. Your administrator may enforce additional password requirements.')}</p></>}
 <button className="primary wide" disabled={busy||(setup&&!authenticated)}>{busy?t('Please wait…'):setup?t('Save password and continue'):mode==='reset'?t('Send reset link'):t('Sign in to dashboard')}<ArrowRight size={17}/></button>
 </form>
 <button className="secondary wide" style={{marginTop:12}} disabled={busy} onClick={()=>{setError('');setNotice('');if(setup){window.history.replaceState({},'',window.location.pathname);onDone();}else setMode(mode==='login'?'reset':'login');}}>{setup?t('Back to workspace / sign in'):mode==='login'?t('Forgot password?'):t('Back to sign in')}</button>
 <p className="small">{t('Individual invited accounts only. Contact your project administrator for an invitation.')}</p>
 {!setup&&<div className="demo-entry"><span>{t('Explore the workflow first')}</span><button className="secondary wide" onClick={onDemo}><FlaskConical size={16}/> {t('Open interactive demo')}</button><small>{t('Illustrative data · stored in this browser · no live AI or real authentication')}</small></div>}
 <footer>{t('Domel Electric Motors Suzhou Co., Ltd.')}</footer></section><section className="login-story"><ShieldCheck size={72}/><span className="eyebrow">{t('DOMEL MARKET INTELLIGENCE')}</span><h2>{t('Research you can trace.')}<br/>{t('Decisions you can review.')}</h2><p>{t('Define a quarterly scope, retrieve public evidence and review every AI finding before it enters a report.')}</p></section></div>;
}
