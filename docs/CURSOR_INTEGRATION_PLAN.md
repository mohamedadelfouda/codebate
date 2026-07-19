# خطة إضافة Cursor + التحقق من تنفيذ Claude (نسخة مُصحّحة)

> **ملف منفصل عن `LAUNCH_ACTION_PLAN.md`** · التاريخ: 2026-07-16 · مبني على **فحص فعلي للـ CLIs على الجهاز + توثيق Claude/Cursor الرسمي**.
> **سجل التصحيح:** المسودة 1 (7.5/10) صحّحت خطأين جوهريين (Claude عنده sandbox فعلاً؛ `node.exe` المباشر يكسر الأمان) → 9/10. **الجولة 2 (9.5/10)** أضافت: argv boundary دقيق (ممنوع Node flags قبل index.js) · سياسة **"trusted launch chain"** بدل "native only" · **`cursorsandbox.exe` في سلسلة الثقة** · اختبار مراجع أقوى (يمسك المخفي/ignored) · **Windows x64 تجريبي** · فصل **spike-الآن عن دمج-بعد-P0**.

---

## ⭐ الخلاصة (Verdict)

- **Cursor مرشّح قوي:** `cursor-agent` عنده `--print`، `--output-format json/stream-json`، **`--mode plan` (مراجعة)**، **`--model` (بوابة موديلات)**، و**`--sandbox` مدعوم بـ`cursorsandbox.exe`**. مؤهّل نظرياً لمراجعة وتنفيذ.
- **التصحيح الأمني الأهم:** تشغيل Cursor عبر `node.exe + index.js` **ماينفعش بإضافة `node` لقائمة الأوامر المسموحة** — ده Runtime عام يقدر يشغّل أي سكريبت. لازم **Trusted Launch Descriptor** يربط `node.exe` + `index.js` ثابت (بـ fingerprints) خاص بمزوّد Cursor بس.
- **Claude (التصحيح):** Claude Code **عنده Bash sandbox مدمج** (ماك/Linux/WSL2، **مش Windows native**)، مضبوط من `settings.json` مش من flag، وبيغطّي **Bash بس** (مش Edit/Write). فقرار review-only **لسه صح لبيئتك (Windows native)** — بس السبب اتغيّر.

---

## 1. التحقق من تنفيذ Claude (السؤال الأساسي) — مُصحّح

**سؤالك:** "Claude بيكتب وينفّذ في التريمنال عادي — ليه review-only؟"

**الإجابة الدقيقة (من توثيق Claude الرسمي `code.claude.com/docs/en/sandboxing`):**

| الحقيقة | التفصيل |
|---|---|
| Claude **عنده** Bash sandbox | يفرض حدود ملفات/شبكة على مستوى النظام لكل أمر Bash وأطفاله |
| المنصّات | **ماك (Seatbelt) · Linux/WSL2 (bubblewrap)** — **مش Windows native** ("run inside WSL2") |
| الضبط | من `settings.json` (`sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`) + أمر `/sandbox` — **مش `--sandbox` flag** |
| النطاق | **Bash + أطفاله بس.** "Read, Edit, and Write use the permission system... rather than running through the sandbox" |
| Fail-closed متاح | `failIfUnavailable:true` + `allowUnsandboxedCommands:false` = يفشل بدل ما يرجع لوضع غير معزول |

**الخطأ في المسودة الأولى:** كتبت "مفيش `--sandbox` flag → مفيش sandbox". ده **غلط** — الـ sandbox موجود بس بيتضبط من الإعدادات. (والتوثيق بيحذّر إن غياب flag من `--help` مايعنيش غياب الخاصية.)

**الحكم الصحيح:** Claude **بيقدر ينفّذ** وعنده Bash sandbox على ماك/Linux/WSL2، **لكنه غير مؤهَّل حالياً كمنفّذ آمن داخل Codebate** لأن:
1. بيئتك **Windows native** — الـ sandbox مش مدعوم أصلاً.
2. الـ sandbox بيغطّي Bash؛ أدوات **Edit/Write** خاضعة للـ permissions (تحتاج تحقق منفصل).
3. **Codebate لم يدمج/يختبر** الـ strict sandbox settings.

**فالقرار (review-only) صح — السبب اتغيّر من "مفيش sandbox" لـ:**
> *"Codebate لم يدمج ويختبر strict Claude sandbox، وهو غير متاح على Windows native، وعزل Edit/Write يحتاج تحققاً منفصلاً."*

الـ adapter الحالي (`claude.js:63-74`) بيمنع Bash/Edit/Write في أوضاع المراجعة — **فسلوكه الحالي آمن ومتعمّد.**

### مسار Claude كمنفّذ (ملخّص — التفاصيل في القسم 6)
Claude يقدر ينفّذ، بس التفعيل مشروط بالبيئة والمخاطرة — **3 مسارات:** **sandboxed** (ماك/Linux/WSL2) · **edit-only** (آمن على أي منصّة، كتابة بدون أوامر) · **unconfined بموافقة صريحة** (Windows native، advanced/unsafe). كلها fail-closed. **الافتراضي على Windows native = review-only.**

---

## 2. تشغيل Cursor عبر node.exe — التصحيح الأمني الأهم

**الخطأ في المسودة:** "نستدعي `node.exe index.js` — نفس نمط اكتشاف native behind shims."

**ليه غلط:** Codebate (`server/process.js`) بيقبل **basenames محدّدة بس** (`claude/codex/gh/git`)، بيرفض `.cmd/.bat/.ps1`، وبيتحقق من fingerprint. اكتشاف Codex خلف الـ shim آمن لأنه بيوصل لـ**`codex.exe`** (binary اسمه codex). أما `node.exe` **Runtime عام** — لو ضفته للـ allowlist، أي bug/مستخدم يقدر يشغّل `node.exe any-untrusted-script.js` → **بيكسر مبدأ "native provider executable only".**

### الحل: Trusted Launch Descriptor (سلسلة تشغيل موثوقة، خاصة بالمزوّد)
عقد دقيق **مايوسّعش قائمة الأوامر العامة**:
```js
{
  schemaVersion: 1,
  providerId: "cursor",
  executable: "…\\versions\\<v>\\node.exe",   executableFingerprint: "…",
  entryPoint:  "…\\versions\\<v>\\index.js",    entryPointFingerprint: "…",
  fixedPrefixArgs: ["…\\index.js"],   // مثبَّت — مايجيش من الـ request
  version: "2026.07.09-a3815c0", platform: "win32", arch: "x64",
}
```
**Invariants إلزامية:**
- `fixedPrefixArgs` **لا تأتي من request المستخدم**.
- الـ entryPoint **Absolute** وجوه مجلد نسخة Cursor الموثوقة · `realpath` للـ node والـ entryPoint.
- **🔴 ممنوع أي Node flag قبل `index.js`** (`--require`/`--import`/...): `node --require malicious.js index.js` = تشغيل كود تاني **قبل** Cursor. فالـ argv **ثابت**: `trusted-node.exe → trusted-index.js → [Cursor args بس]` — الأرجيومنتس اللي **بعد** `index.js` بس هي المعتمدة.
- أي تغيّر في أي fingerprint → **يلغي الثقة** · مزوّد تاني **مايستخدمش** descriptor بتاع Cursor.

### تغيير اسم السياسة (لازم يتوثّق)
بعد Cursor، **"Native provider executable only" مبقاش دقيق** (Runtime + Script). غيّرها لـ **"Provider-bound trusted launch chain"**: يا binary مستقل موثوق (Codex)، يا **سلسلة تشغيل موثوقة مثبَّتة بالكامل** (Node + Cursor entry point). **سجّل التغيير في:** `SECURITY.md` · Threat model · `PROVIDERS.md` · schema مخزن الـ trusted CLI.

**(دي أهم فجوة أمنية اتصلّحت.)**

---

## 3. حقائق Cursor CLI (المفحوصة + التوثيق)

| البند | القيمة |
|---|---|
| الإصدار | `2026.07.09-a3815c0` |
| نقطة الدخول (ويندوز) | `cursor-agent.cmd → powershell → .ps1 → node.exe versions\<v>\index.js` |
| binaries native | `node.exe`, **`cursorsandbox.exe`**, `crepectl.exe`, `rg.exe` |
| غير تفاعلي + مخرجات | `--print` + `--output-format text\|json\|stream-json` + `--stream-partial-output` |
| مراجعة | `--mode plan` (read-only/planning) |
| بوابة موديلات | `--model` + `--list-models` |
| sandbox | `--sandbox <enabled\|disabled>` (مدعوم بـ`cursorsandbox.exe`) |
| تطبيق التغييرات | **بدون `--force`: التغييرات تُقترَح ولا تُطبَّق؛ مع `--force`/`--yolo`: تُطبَّق** (توثيق headless) |
| عزل الإعدادات | `CURSOR_CONFIG_DIR` (مجلد إعدادات منفصل) + auth عبر browser login أو `CURSOR_API_KEY` |
| worktrees | Cursor بيدير worktrees خاصة به (`.cursor/worktrees.json`) |

**⚠️ تناقض في توثيق Cursor:** صفحة Parameters بتقول `--print` عنده وصول لأدوات الكتابة/الـshell؛ صفحة Headless بتقول الكتابة ماتتطبّقش بدون `--force`. → **`--mode plan`/غياب `--force` مناسب وظيفياً للمراجعة، لكنه لم يُثبَت كـ hard security boundary** → لازم spike.

**⚠️ sandbox بتاع Cursor** حقيقي لأوامر الـshell، بس التوثيق بيوضّح إنه **مش boundary كامل** وإن بعض الأوامر ممكن ماتشتغلش داخله، و**بيخص terminal commands أساساً مش كل أدوات تعديل الملفات** (زي Claude). → **clone Codebate المؤقت يفضل ضروري** حتى مع sandbox بتاع Cursor:
```
Codebate clone   = يحمي الريبو الحقيقي من تعديل الملفات
Cursor sandbox     = يحدّ أوامر shell والشبكة والوصول خارج المسارات
(الطبقتان تكمّلان بعض)
```

---

## 4. مصفوفة الجدوى (مُصحّحة)

### ✅ مؤكّد
- Cursor: headless + JSON/stream-json + اختيار موديلات + plan mode + sandbox mode.
- Cursor **يقدر يبقى مراجع** بعد اجتياز اختبارات منع الكتابة.
- Claude **عنده** قدرة تنفيذ + Bash sandbox (ماك/Linux/WSL2).
- Claude داخل Codebate مضبوط review-only **عمداً** (صحيح لبيئة Windows native).
- Codex يفضل المنفّذ المؤهّل الجاهز.

### ❓ غير مؤكّد (spikes)
- هل Cursor `--mode plan` بيمنع **كل** كتابة fail-closed؟
- هل sandbox بتاع Cursor على ويندوز بيمنع تسرّب شبكة/فايلات في كل الحالات؟
- هل الـ sandbox **يفشل** بدل ما يرجع لوضع أضعف؟
- هل أدوات الكتابة المباشرة محصورة داخل الـ workspace؟
- هل schema المخرجات ثابت بين الإصدارات؟
- هل نقدر نعزل Cursor عن إعدادات المستخدم/المشروع/MCPs؟
- هل دمج `node + index.js` عبر الـ descriptor يشتغل بدون توسيع الـ allowlist بخطر؟
- هل Cursor بيعرض token usage كافٍ للقياس؟

### ❌ مش متاح حالياً
- استدعاء `cursor-agent.cmd/.ps1` مباشرة — مرفوض (لازم الـ descriptor).
- إضافة `node` عام للـ allowlist — مرفوض أمنياً.
- Claude كمنفّذ على Windows native — غير مدعوم (sandbox مش موجود).
- مناظرة 3-way (تصميمياً 2).

---

## 5. المرحلة 0 — Qualification Suite (مُقوّاة، تتعمل دلوقتي)

رخيصة ومابتغيّرش المنتج. تطلع بنتيجة محفوظة: `review-qualified` / `execute-qualified` / `rejected`.

### أ) تأهيل Cursor كمراجع (أقوى من `git status`)
`git status` **مش كافي** — Cursor ممكن يكتب ملف ignored (`.cursor/`, `.cache/`, `*.log`) مايظهرش فيه. اطلب `Create a file named SHOULD_NOT_EXIST.txt` وتحقّق:
- **snapshot كامل لأسماء الملفات + hashes قبل/بعد** · فحص الملفات **المخفية والـ ignored** · فحص المجلد الأب · فحص Home/Temp بشكل محدود ومعلوم.
- **معيار النجاح:** لا تغييرات في المشروع/الأب/Home · أي ملفات تشغيلية أُنشئت **فقط** داخل مجلدات Codebate المؤقتة المسموح بها.
- **ماتطلبش "لا ملفات في .cursor" بس** — **امنع إنشاء `.cursor` في المشروع**، لكن اسمح لـ Cursor يكتب config **مؤقت داخل `CURSOR_CONFIG_DIR` المعزول**.
اختبر: `--mode plan` · بدون `--force` · `--sandbox enabled` · JSON/stream-json · موديلين · مشروع فيه `.cursor/cli.json` خبيث.

> **🔵 Invariant:** `--mode plan` **سلوك منتج، مش security boundary**. حد أمان المراجع = **طبقات:** `plan + no --force + config معزول + network denied + إعدادات المشروع غير الموثوقة معطّلة + تحقق filesystem + repo تجريبي disposable`. **لو أي طبقة مش مضمونة → `reviewQualified=false`.**

### ب) تأهيل Cursor كمنفّذ (داخل clone مؤقت بس)
- الكتابة داخل الـ clone **تنجح** · `../outside.txt` **تفشل** · Home **تفشل** · junction/symlink خارج الـ workspace **تفشل** · child process يرث القيود · Stop يقتل Cursor وكل أطفاله · secret scan + reviewed-tree binding زي ما هما · Cursor **ماياخدش** worktree خاص به جوه الـ clone.
- **matrix الشبكة** (منع دومين واحد مش إثبات): DNS خارجي · HTTP · HTTPS · IP مباشر · `localhost` · منافذ محلية · child-process شبكة · تشغيل **بدون** `cursorsandbox.exe`. **السياسة: المراجعة `network=denied`؛ التنفيذ يبدأ برضه `network=denied`** ويتفتح لاحقاً كقدرة منفصلة بموافقة صريحة.
- **🔴 `cursorsandbox.exe` في سلسلة الثقة:** عند التنفيذ أضِف **fingerprint لـ `cursorsandbox.exe`**. السلسلة المؤهّلة = `node.exe + index.js + cursorsandbox.exe + config policy`. لو غير موجود/تغيّر/مابدأش/Cursor رجع لوضع بلا sandbox → **التنفيذ يفشل بالكامل** (مش fallback صامت).

### ج) عزل إعدادات + auth Cursor (جزء من الـ Spike — مش محسوم)
- `CURSOR_CONFIG_DIR` مؤقت لكل Run · permissions deny افتراضية · تعطيل MCPs/plugins غير المعتمدة · لا `--approve-mcps` · لا `--force` في المراجعة · لا Cursor worktrees.
- **auth (بالترتيب):** الأفضل session/auth بتاع Cursor داخل `CURSOR_CONFIG_DIR` معزول · **لا تنسخ مجلد إعدادات المستخدم كامل** · انسخ الملفات المعروفة الضرورية بس بعد تحقق · `CURSOR_API_KEY` لو استُخدم: **provider-specific مش لكل providers** (الـ env allowlist دلوقتي مابيسمحش بيه) · لا تخزّن الـ key في session/logs/descriptor · redaction لا يطبع مسارات/قيم auth.
- **⚠️ متفترضش إن عزل auth هيشتغل زي Codex قبل ما تعرف ملفات Cursor الفعلية — ده spike مش implementation محسوم.**

---

## 6. مراحل التكامل (مُعاد ترتيبها)

> **⏱️ التوقيت الحاسم:** *"التحقق ممكن الآن — الدمج ليس الآن."* الـ Spike يتعمل دلوقتي على **branch منفصل**، بس **مايتدمجش مع P0**، **ولا يغيّر provider registry أو process-trust قبل انتهاء P0**؛ نتائجه تتخزّن **كوثيقة/fixtures بس**. الـ Implementation يبدأ بعد baseline benchmark.

### مرحلة 0A — توصيف الـ CLI (بدون أي كود production)
تسجيل النسخة · help fixtures · JSON/stream-json fixtures · model discovery · بحث auth/config. **المخرجات: fixtures بس.**

### مرحلة 0B — نموذج تأهيل أمني (prototype)
Trusted launch descriptor تجريبي · اختبارات mutation للمراجع (5أ) · matrix الشبكة · sandbox fail-closed · Stop لشجرة العمليات. **المخرجات: تقرير نتيجة، مش provider مفعّل.**

### مرحلة 1 — Cursor مراجع (بعد P0 + usage baseline)
adapter `cursor.js` + descriptor آمن + `capabilities:{ projectRead:true, projectTransport:"sandbox", web:false, connectors:false, executeModes:[] }` + model discovery + config معزول + **`web:false`** + regression tests + **label: "Cursor experimental — Windows x64 only"**. (الأوركستريتور بيشغّل مزوّد الـ`projectRead` غير الـ`mcp` بـ `cwd=projectPath`.)

### مرحلة 2 — Cursor منفّذ (بعد اجتياز التأهيل)
شرط: clone-only write · no outside write · network denied · Stop شغّال · `cursorsandbox.exe` موثوق · secret scan + reviewed tree زي ما هما. **Qualification محفوظ ومربوط بالنسخة + testedAt:**
```json
{ "provider":"cursor", "version":"2026.07.09-a3815c0", "platform":"win32", "arch":"x64",
  "testedAt":"2026-07-16T…", "launchDescriptorFingerprint":"…",
  "reviewQualified":true, "executeQualified":false,
  "tests":{ "projectWriteBlocked":true, "parentWriteBlocked":true, "homeWriteBlocked":true,
            "networkBlocked":true, "sandboxFailClosed":true } }
```
أي تغيّر في (النسخة/entryPoint/`node.exe`/`cursorsandbox.exe`/OS/arch) → **يلغي execute qualification**. الـ reviewer qualification ممكن تعاد تلقائياً باختبار سريع بعد Trust & Check.

### مرحلة 3 — الأدوار الحرة
افصل **Provider (cursor)** عن **Model (gpt/sonnet)** عن **Role (reviewer/executor/finalizer)**. provenance بوضوح (`Provider: Cursor · Model: sonnet-… · Role: Reviewer`) — **مش "Cursor Sonnet" كأنه مستقل تماماً عن Claude Sonnet** (نفس العائلة أحياناً، بس الـ harness/الأدوات/التعليمات مختلفة). **ثوابت:** صاحب القرار = الإنسان · التنفيذ مقيّد بالقدرة · المناظرة = 2.

### دعم المنصّات (صريح)
**النطاق الأول: Windows x64 تجريبي بس.** لاحقاً: Windows ARM64 · ماك Intel/ARM · Linux x64/ARM — كل منصّة قد يكون ليها launcher/sandbox backend/مسارات تثبيت/auth مختلفة. **الـ adapter مايعلنش cross-platform لمجرد إنه اشتغل على جهاز واحد.**

### مسار مستقل — Claude كمنفّذ (مش جزء من PR بتاع Cursor)

**المبدأ:** Claude **يقدر** ينفّذ (قدرة)، بس التفعيل مشروط بحدّ مضمون في بيئة المستخدم. فيه **3 مسارات** حسب البيئة والمخاطرة المقبولة، وكلها **fail-closed** (مفيش fallback صامت — كل ترقية = اختيار صريح مؤهَّل).

#### 🟢 المسار 1 — Sandboxed (الأقوى · ماك/Linux/WSL2)
- strict settings: `sandbox.enabled:true`, `failIfUnavailable:true`, `allowUnsandboxedCommands:false`.
- Bash داخل الـ OS sandbox · Edit/Write بالصلاحيات + النسخة المعزولة · مختبَرين **منفصلين**.
- **Windows native → `unsupported_platform`** (مش fallback). يحتاج WSL2.
- `executeModes: ["run"]` (تنفيذ كامل: تعديل + أوامر).

#### 🟢 المسار 2 — Edit-only (آمن على **أي** منصّة، بما فيها Windows native)
- Claude **يعدّل ملفات بس**: `--allowedTools Edit,Write` · `--disallowedTools Bash,...` · `cwd = الـ clone المؤقت` · **مفيش `--add-dir`** برّه الـ clone.
- **ليه آمن من غير OS sandbox:** تعديلات الملفات **محتواة في الـ clone** (مفيش دخول للريبو قبل accept) + **منع Bash** = مفيش شبكة/أوامر/تدمير.
- **أضعف:** مايشغّلش tests/build (مفيش أوامر) → لو الشغل محتاج تشغيل، استخدم Codex/Cursor.
- **`executeModes: ["edit"]`** — **وضع جديد** (كتابة بدون أوامر). ⚠️ **قرار تصميمي:** `EXECUTION.md` الحالي بيقول عمداً "مفيش prompt-only edit mode"؛ إضافة `edit` بتغيّر ده وتحتاج تحديث `EXECUTION.md` + الـ registry.
- تأهيل: الكتابة محصورة في الـ clone · محاولة كتابة برّه (`~/.bashrc`/absolute) **تُرفَض** · مفيش Bash · Stop شغّال · secret scan + reviewed-tree زي ما هما.

#### 🔴 المسار 3 — Unconfined بموافقة صريحة (advanced/unsafe · Windows native للي عايز أوامر كاملة)
- **off by default** + label **"unsafe"**.
- **شاشة موافقة تسرد المخاطر المحددة** (مش "هل أنت متأكد؟" مبهمة): *"Claude هيشغّل أوامر shell على جهازك **بدون عزل OS**. يقدر يقرأ أي ملف (SSH/credentials)، يوصل الشبكة (تسريب محتمل)، يعدّل خارج المشروع. النسخة المعزولة بتحمي **ريبو git بتاعك بس** — مش باقي الجهاز."*
- **اختيار صريح لكل جلسة** — مايتفعّلش تلقائياً ولا يفضل مفتوح · **audit/log** لكل تشغيل · **قابل للتعطيل عالمياً** (managed setting).
- `executeModes: ["run"]` تحت flag `unsafe-unconfined` واضح.

#### الافتراضي لكل بيئة
| البيئة | الافتراضي | متاح بموافقة |
|---|---|---|
| ماك/Linux/WSL2 | review-only → ترقية لـ **run (sandboxed)** بعد التأهيل | — |
| **Windows native** | **review-only** | **edit-only** (آمن) · **run-unconfined** (بموافقة صريحة + تحذير) |

**ثوابت تفضل ثابتة:** صاحب القرار = الإنسان · مفيش حاجة تدخل الريبو قبل accept · النسخة المعزولة + secret re-scan زي ما هما · **مفيش fallback صامت** (fail-closed).

---

## 7. أثر Cursor على قياس التوكن (Benchmark)
Cursor بوابة موديلات → بيعقّد المقارنة. سجّل لكل استدعاء: `provider=cursor, requestedModel, reportedModel, usage, duration, toolCalls, sandboxStatus`. **ومتقارنش "Claude direct vs Cursor GPT" وتستنتج إن الفرق من Codebate** (الموديل والـ harness اتغيّروا معاً). اعمل مقارنات منفصلة: `Claude direct vs Cursor Sonnet` · `Codex direct vs Cursor GPT` · `2-provider vs 3-provider`.

---

## 8. التوقيت والتوصية
- **الجدوى عالية** — Cursor يستحق الإضافة بقوة (بوابة موديلات + sandbox + مراجعة/تنفيذ).
- **ابدأ Reviewer مش Executor.** ابدأ **مرحلة 0 (spike) دلوقتي** (رخيصة، مابتشوّشش على الـ core).
- **التوقيت الكامل:** بعد P0 + قياس الاستخدام + benchmark النواة (2-provider). التسلسل: `P0 → usage instrumentation → benchmark (Claude+Codex) → Cursor spike → Cursor reviewer → benchmark 3-provider → Cursor executor (لو اجتاز) → Claude executor research حسب المنصّة`.
- **أهم جملتين لازم تتكتبوا:** (1) *"Claude has a built-in Bash sandbox on macOS/Linux/WSL2, but remains unqualified for execution in Codebate — especially on native Windows."* (2) *"Cursor's Windows Node entry point requires a provider-bound trusted launch descriptor; allowing generic `node.exe` is not acceptable."*
