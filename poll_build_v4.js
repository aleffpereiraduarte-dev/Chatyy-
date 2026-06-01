// Polls App Store Connect until a build with marketing version 4.0.0 is VALID.
const crypto=require("crypto"),fs=require("fs"),https=require("https");
function jwt(){const key=fs.readFileSync(__dirname+"/asc_key.p8");const now=Math.floor(Date.now()/1000);const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const hp=b({alg:"ES256",kid:"QSYM3KX73P",typ:"JWT"})+"."+b({iss:"494360d0-0420-4f1f-a1db-6be19eeb2d89",iat:now,exp:now+500,aud:"appstoreconnect-v1"});return hp+"."+crypto.createSign("SHA256").update(hp).sign({key,dsaEncoding:"ieee-p1363"}).toString("base64url");}
function get(path){return new Promise((res,rej)=>{https.request({host:"api.appstoreconnect.apple.com",path,method:"GET",headers:{Authorization:"Bearer "+jwt()}},x=>{let c=[];x.on("data",d=>c.push(d));x.on("end",()=>{try{res(JSON.parse(Buffer.concat(c).toString()))}catch(e){rej(e)}})}).on("error",rej).end();});}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  for(let i=0;i<70;i++){
    try{
      // newest builds, include marketing version
      const j=await get("/v1/builds?filter%5Bapp%5D=6759975575&limit=8&sort=-uploadedDate&include=preReleaseVersion");
      const inc=(j.included||[]).reduce((m,x)=>{m[x.id]=x;return m},{});
      let hit=null;
      for(const b of (j.data||[])){
        const pid=b.relationships.preReleaseVersion?.data?.id;
        const mv=pid&&inc[pid]?inc[pid].attributes.version:"?";
        if(mv==="4.0.0"){ hit={id:b.id,build:b.attributes.version,state:b.attributes.processingState}; break; }
      }
      if(hit){
        console.log(`[poll ${i}] 4.0.0 build ${hit.build}: ${hit.state}`);
        if(hit.state==="VALID"){console.log("READY v4build_id="+hit.id+" buildnum="+hit.build);process.exit(0);}
        if(hit.state==="FAILED"||hit.state==="INVALID"){console.log("BUILD FAILED state="+hit.state);process.exit(2);}
      } else {
        console.log(`[poll ${i}] no 4.0.0 build on ASC yet`);
      }
    }catch(e){console.log(`[poll ${i}] err ${e.message}`);}
    await sleep(150000);
  }
  console.log("TIMEOUT: 4.0.0 build not VALID");process.exit(1);
})();
