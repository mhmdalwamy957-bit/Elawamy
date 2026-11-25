import {auth,onAuthStateChanged,db,doc,getDoc,setDoc,serverTimestamp} from './firebase.js';
const ids=['orders','messages','offers','community','email','push'];const msg=document.getElementById('message');
async function load(){const u=auth.currentUser;if(!u){msg.textContent='سجّل الدخول أولًا.';return;}const s=await getDoc(doc(db,'notificationSettings',u.uid));const x=s.exists()?s.data():{};ids.forEach(id=>document.getElementById(id).checked=x[id]!==false);}
document.getElementById('save').onclick=async()=>{const u=auth.currentUser;if(!u)return;const data=Object.fromEntries(ids.map(id=>[id,document.getElementById(id).checked]));try{await setDoc(doc(db,'notificationSettings',u.uid),{...data,updatedAt:serverTimestamp()},{merge:true});msg.textContent='✅ تم حفظ الإعدادات';}catch(e){msg.textContent='❌ '+e.message;}};
onAuthStateChanged(auth,load);
