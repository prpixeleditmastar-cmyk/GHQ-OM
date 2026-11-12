# GHQ O&M — सेटअप मार्गदर्शक (सर्व फ्री)

**काय आहे:** तुमची Golden Edition HTML → खरा अँप. १५ लोक नाव+PIN ने लॉगिन करतात, एन्ट्री तुमच्या Google Drive च्या Sheet मध्ये जमा होतात, फोटो Drive फोल्डरमध्ये जातात, नेट नसेल तर फोनवर राहून नंतर आपोआप जातात. रोज रात्री बॅकअप.

## भाग १ — Google Drive बाजू (१० मिनिटे)
खाते: **prpixeleditmastar@gmail.com**

1. https://script.google.com उघडा → **New project** → आतला सगळा कोड काढून `Code.gs` ची फाईल पूर्ण पेस्ट करा → Save.
2. वरच्या ड्रॉपडाउनमधून **setup** निवडा → **Run** → परवानगी द्या (*Advanced → Go to project (unsafe)* → Allow; हा तुमचाच स्क्रिप्ट आहे).
3. खाली *Execution log* मध्ये Sheet ची लिंक दिसेल. Drive मध्ये आता **GHQ O&M Data** (Sheet), **GHQ_OM_Photos**, **GHQ_OM_Backups** तयार झाले.
4. **Deploy → New deployment → Web app** → *Execute as:* **Me**, *Who has access:* **Anyone** → Deploy → **Web app URL** कॉपी करा.
5. `www/config.example.js` ची कॉपी `www/config.js` नावाने बनवा आणि `PASTE_WEB_APP_URL_HERE` च्या जागी ती URL टाका. (config.js एकदाच बनवायची; नंतर अपडेट करताना ती पुन्हा अपलोड करू नका. URL नसेल तर बिल्ड मुद्दाम लाल होतो.)

## भाग २ — APK बनवणे (फ्री, GitHub)
1. github.com वर फ्री खाते → **New repository** (Private) → या प्रोजेक्टच्या सर्व फाईल अपलोड करा (`.github` फोल्डरसह).
2. **Actions** टॅब → **Build APK** → **Run workflow**. ५–८ मिनिटांत संपेल.
3. रन उघडा → खाली **Artifacts → GHQ-OM-apk** डाउनलोड → unzip → `app-debug.apk`.
4. ही फाईल १५ लोकांना WhatsApp ने पाठवा. फोनवर उघडून *Install* (प्रथम "Unknown sources" परवानगी).

## भाग ३ — पहिला वापर
- लॉगिन: **Parashram / 1234** → लगेच **Menu → Users & PIN** मध्ये स्वतःचा PIN बदला (तेच नाव + नवीन PIN → Save).
- १५ जणांची नावे, PIN, काम (Electrical/HVAC/Plumbing/Supervisor) टाका. कोणाला काढायचे तर *Remove* (जुन्या एन्ट्री राहतात).
- पहिले रीडिंग = "opening reading". दुसऱ्या दिवशीपासून वापर आपोआप निघतो.

## कोण काय पाहते
- **सर्व:** Readings, Tickets, AMC सर्वांना दिसतात (म्हणजे मागच्या रीडिंगची साखळी बरोबर राहते).
- **Staff:** *Entries* मध्ये फक्त स्वतःच्या एन्ट्री.
- **Admin:** सर्वांच्या एन्ट्री (user filter), Users, Backup & Restore.
- AMC नोंदी फक्त Admin / Supervisor करू शकतात.

## बॅकअप
- **रोज रात्री ~२ वाजता** Sheet ची कॉपी Drive च्या *GHQ_OM_Backups* मध्ये (शेवटच्या ३० ठेवते).
- Admin → **Backup & Restore:** *Backup now*, Full backup (.json), Readings/Tickets Excel (.csv) डाउनलोड, आणि .json मधून **Restore** (दोनदा केले तरी डुप्लिकेट होत नाही).

## लक्षात ठेवा
- कोड बदलून Apps Script पुन्हा Deploy करताना **Manage deployments → Edit → New version** वापरा, म्हणजे URL तीच राहते.
- फोटोच्या लिंक "link असलेल्यांना view" अशा आहेत (अंदाज लावता न येणाऱ्या). Sheet स्वतः फक्त तुमच्याकडे.
- अँप अपडेट करायचा तर `www` मधील फाईल बदलून GitHub वर अपलोड → नवा APK → लोक पुन्हा install करतात.
- सध्या खरे चालणारे: Readings, Tickets (Close/Hold), AMC (नवे/Renew), फोटो. Dashboard वरचे वरचे आकडे, PTW/FLS/Spares/Roster, PDF/Excel रिपोर्ट अजून डिझाईनप्रमाणेच (डेमो) आहेत — पुढच्या टप्प्यात जोडू.
- `KEEP_DEMO_TICKETS` (config.js): `false` = मूळ डिझाईनमधील नमुना तिकिटे काढलेली. AMC ची मूळ यादी तशीच ठेवली आहे.

## Readings साठी Panel / Feeder यादी (Google Sheet मधून)
- Sheet **GHQ O&M Data** मधील **Feeders** टॅबमध्ये कॉलम: **Type** (Electrical / Water / BTU), **Panel**, **Feeder**, **Active** (✔).
- नवा Panel/Feeder हवा तर नवी ओळ जोडा (Type निवडा, Active ✔). अँप पुन्हा बनवण्याची गरज नाही; पुढच्या सिंकला (अँप उघडल्यावर / वरच्या Synced वर टॅप केल्यावर / दर १ मिनिटाला) दिसतो.
- एकाच Panel चे नाव अनेक ओळींत सारखेच ठेवा, म्हणजे ते एका Panel खाली येतात.
- Feeder काढायचा असेल तर ओळ **delete करू नका**, Active चा टिक काढा (जुने रीडिंग राहतात).
- **नाव बदलू नका**: नाव बदलले तर तो नवा Feeder समजला जातो आणि त्याचे पहिले रीडिंग पुन्हा "opening" होते. नाव चुकले असेल तर जुना Inactive करून नवा जोडा.
- कोड बदलल्यामुळे: Apps Script मध्ये नवा `Code.gs` पेस्ट करा → `setup` पुन्हा Run (सुरक्षित, डेटा पुसला जात नाही) → **Deploy → Manage deployments → Edit → New version → Deploy**.

## Monthly Excel report (v5: panel-wise)
Readings पेजवर **Monthly readings Excel (panel-wise)**: महिना निवडा → **Download Excel**. फाईलमध्ये **प्रत्येक Panel ची वेगळी शीट**: वर Feeders (प्रत्येकाचे Reading + Consumption), डावीकडे Day + Date, शेवटी Total. फाईल फोनच्या **Downloads/GHQ-OM** फोल्डरमध्ये सेव्ह होते. हे फक्त Admin / Engineer / RIL / PM / APM ला दिसते.

## Roles (v4)
- **Admin:** Users & PIN, Backup & Restore, आणि Readings पेजवर **Add panel / feeders** (नवा Panel किंवा Feeder → Feeders शीटमध्ये जातो).
- **Staff:** फक्त रीडिंग भरतात आणि सेव्ह करतात. Users, Backup, Add panel त्यांना दिसत नाही.
- लॉगिन स्क्रीनवर **Check connection** आणि खाली अँपची आवृत्ती (v4) दिसते. लॉगिन अडल्यास त्यावरून कारण कळते.


## v5 — काय नवीन
**Roles (Users शीट → Role कॉलम, dropdown):** Admin, Engineer, RIL, PM, APM, Supervisor, Staff.
| काम | कोणाला |
|---|---|
| Excel डाउनलोड (Readings Excel, Tickets Excel) | Admin, Engineer, RIL, PM, APM |
| E-ticket **Hold** | Admin, Engineer, Supervisor (Role किंवा Work = Supervisor) |
| PPM मध्ये **नवीन equipment add** | Admin, Engineer, Supervisor |
| PPM **Mark done**, Readings, Tickets भरणे | सर्वजण |
| Users, Backup, नवा Panel add | फक्त Admin |

**PPM Calendar:** Google Sheet **GHQ O&M Data → PPM** टॅब: Category | Equipment | Location | Frequency | Last done | Team / Vendor | Checklist (प्रत्येक पॉईंट नव्या ओळीत किंवा `;` ने) | Active. ओळ जोडली की अँपमध्ये Calendar आणि Electrical/HVAC/Plumbing याद्या आपोआप दिसतात (किंवा अँपमधील **Add equipment** बटण). पुढची Due तारीख = Last done + Frequency. अँपमध्ये **Checklist / Done** → तारीख → **Mark done** केले की पुढची तारीख आपोआप पुढे सरकते (नोंद **PPM Log** टॅबमध्ये).

**Downloads:** अँपमधून जे काही डाउनलोड होते (Excel, CSV, backup) ते फोनच्या **Downloads/GHQ-OM** फोल्डरमध्ये सेव्ह होते.

**Auto-update (एकदाच सेटअप):**
1. GitHub repo → Settings → **Pages** → Source: **GitHub Actions**. (फ्री Pages साठी repo **Public** हवा: Settings → General → Danger Zone → Change visibility.)
2. Public करण्यापूर्वी Apps Script URL लपवा: Settings → Secrets and variables → Actions → **New repository secret** → Name `API_URL`, Value = Web app URL. मग repo मधील `www/config.js` delete करा.
3. नवा APK एकदाच install करा (पुढे नाही).
4. यापुढे बदल करायचा तर फक्त GitHub वर फाईल अपलोड करा → Actions संपला की लोकांच्या अँपमध्ये वर **“New version ready — tap to update”** येते (किंवा पुढच्या वेळी अँप उघडल्यावर नवी आवृत्ती चालते). APK पुन्हा install नको. (फक्त फोनच्या मूळ भागात बदल — उदा. नवे permission — असेल तेव्हा नवा APK लागतो.)

**Main sheet:** तयारी Code.gs मध्ये आहे पण सध्या **बंद** (`MAIN_ENABLED = false`) — नंतर चालू करू.
