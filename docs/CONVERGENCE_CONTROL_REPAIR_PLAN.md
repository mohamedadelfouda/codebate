# Codebate — خطة إصلاح اعتماد التقارب وـControl Repair

> **الحالة:** نُفذت على أحدث `origin/main`، والتحقق النهائي موثق في القسم 0
> **التاريخ:** 2026-07-18
> **خط الأساس التاريخي للخطة:** `main @ abd9374`
> **خط أساس التنفيذ بعد التحديث:** `origin/main @ 9006a352794878404f9905a8c9862a6e35744185`
> **نطاق التنفيذ:** `server/convergence.js` و`server/prompts.js` و`server/orchestrator.js` وCLI adapters وسجل قدرات المزودين والاختبارات والتوثيق المرتبط بها

---

## 0. نتيجة التنفيذ على أحدث نسخة

قبل التنفيذ جرى تحديث `main` إلى `origin/main @
9006a352794878404f9905a8c9862a6e35744185`. كانت النسخة الأحدث قد أضافت
بالفعل parsing خطيًا ومتسامحًا مع النص المحيط بالـControl، وControl Repair
أساسية للبلوك المفقود أو غير الصالح، وقياس usage حقيقي من المزودين، وحارس
early-stop قائمًا على العمل المتبقي. احتُفظ بهذه التحسينات ولم تُنفذ مرة ثانية.

التنفيذ الإضافي الذي أثبتت الاختبارات الحاجة إليه هو:

- قائمة Repair مغلقة بالأكواد:
  `missing_control`، `invalid_control_json`، `invalid_control_schema`،
  `target_version_mismatch`، و`unaddressed_open_item`. أي كود آخر يفشل
  بشكل محافظ.
- اشتقاق completion من البنود المفتوحة بأولوية حتمية لا تتأثر بترتيب
  الـarray:
  `agent/resume_agent_round → incomplete` ثم
  `{user|human_operator|orchestrator}/run_external_check → blocked` ثم
  `user/provide_decision → needs_user` ثم `satisfied`.
- منع terminal claim من إغفال بند مفتوح. `keep_open` مع
  `goalStatus: satisfied` يظل خطأ غير قابل للـRepair، بينما الإغفال المحدد
  ينتج `unaddressed_open_item` قابلًا لإصلاح التمثيل.
- نقل Repair إلى ما بعد التقييم الأول للجولة، بحيث تستهدف فقط
  `repairTargets` المثبتة، مع استدعاء واحد كحد أقصى لكل Control مستهدفة ومن
  دون استهلاك جولة نقاش.
- التحقق من ضيق الإصلاح: الـControl الصالحة أصلًا لا يجوز أن تغيّر
  `convergence` أو `goalStatus` أو `substantiveDelta` أو proposal غير متعلق
  بالعيب. يسمح فقط بتصحيح `targetVersion` عند الحاجة وإضافة إجراءات البنود
  المغفلة المحددة. البلوك المفقود أو malformed بالكامل يجوز إعادة توليده ثم
  يمر بالتقييم الحتمي نفسه.
- تشغيل Repair في scratch workspace وبصلاحية `read`، دون MCP أو connectors،
  وببيئة agent المنظفة الموجودة في `server/process.js`. حد الزمن 60 ثانية
  وحد خرج المزود 64 KiB، وكلا الـadapterين يمرران هذا الحد إلى طبقة العملية
  قبل إعادة النتيجة.
- لا يبدأ الاستدعاء إلا لمزود يعلن قدرة `controlRepair: "tool-free"`.
  Claude مؤهل حاليًا لأن وضعه يعطّل كل الأدوات، بينما Codex يسجل
  `repair_not_supported` من دون إطلاق process لأن read-only لا يعزل قراءة
  ملفات الجهاز. scratch workspace وحدها ليست حدًا أمنيًا للقراءة.
- حفظ audit مستقل في `message.meta.controlRepair` من دون استخدام
  `retryCount`، مع snapshots محدودة للـControl الأصلية والمصححة، وعدم حفظ
  النص الخام أو reasoning. تُحفظ الإحصاءات الاختيارية في
  `officialOutcome.controlRepairStats`، ويُجمع usage الحقيقي فقط إذا أعاده
  المزود؛ لا تُختلق أرقام tokens.
- اختبار persistence round-trip أثبت أن الـschema الحالية تحفظ الحقلين
  الاختياريين؛ لذلك لم يحتج `server/session-schema.js` أو `server/store.js`
  إلى تعديل إنتاجي. كذلك لم يحتج `server/run-state.js` أو `server/process.js`
  إلى تعديل إنتاجي؛ استُخدمت عقودهما الحالية واختُبرت مباشرة.

التحقق النهائي على هذه الحالة نجح في `npm run check` (51 ملفًا)،
و`npm run lint`، و`npm test` (كل الاختبارات ناجحة، بلا فشل أو skip).

الأقسام التالية تحتفظ بتحليل الخطة الأصلي وخطواتها كمرجع تاريخي لقرار
التنفيذ على `abd9374`. عند اختلاف صياغة «السلوك الحالي» فيها مع القسم 0،
فهي تصف ذلك الـcommit التاريخي، بينما القسم 0 ووثيقة المعمارية يصفان
التنفيذ الحالي.

---

## 1. القرار التنفيذي

الإصلاح المطلوب ليس تغيير رسالة النهاية ولا جعل الـfinalizer يقرر هل حدث اتفاق. المطلوب هو إصلاح المسار الرسمي نفسه:

```text
agent itemProposals
→ validation
→ approved itemRegistry
→ derived convergence/completion state
→ early stop decision
→ persisted outcome
→ finalizer explanation
```

سيظل هذا المسار هو المصدر الوحيد للحقيقة. النص الحر الذي يكتبه الوكلاء يظل شرحًا للقارئ، ولا يغلق بندًا ولا يغيّر نتيجة رسمية وحده.

الإصلاح يتكون من ثلاث طبقات مترابطة:

1. منع اعتماد `converged + satisfied` بينما توجد بنود رسمية مفتوحة وغير متسقة مع هذه النتيجة.
2. تقوية عقد الـprompt حتى يراجع الوكيل البنود المفتوحة ويقترح إجراءً صريحًا باستخدام نفس `itemId`.
3. إضافة **control-repair pass واحدة ومحدودة** للأخطاء القابلة للإصلاح، من غير استهلاك جولة مناظرة أو اختراع اتفاق.

---

## 2. الحالة المرجعية التي يجب إصلاحها

السيشن المصدّرة بعنوان **«تقييم الريبو»** هي regression case الأساسية. التسلسل الظاهر فيها هو:

1. ظهر خلاف يحتاج قرار مستخدم وتم تمثيله كبند رسمي قديم، `item-001`.
2. لاحقًا سحب Codex اقتراح تجميد 30 يومًا.
3. اتفق Claude وCodex نصيًا على:

   ```text
   P0 → P1-7 Usage Instrumentation → eval
   ```

4. اتفق الطرفان على عدم إضافة ميزات أو موصلات أو مزودين جدد قبل نتيجة الـeval.
5. اتفقا على دخول التطبيق وضع الصيانة وحفظ `convergence.js` كأصل مستقل إذا فشل التقييم.
6. قال الطرفان صراحة إن `item-001` حُسم ولم يعد يحتاج قرار المستخدم.
7. رغم ذلك استمرت السيشن حتى الجولة الخامسة وانتهت برسالة تفيد بعدم وجود اتفاق مؤكّد.
8. ملف التصدير حمل `Status: running` بعد انتهاء الجولات.

ملف Markdown المصدّر لا يحتوي بلوكات `<agent-control>` الداخلية؛ لذلك لا يمكن إثبات هل الوكلاء أرسلوا `keep_open` أو أغفلوا `item-001` أو أرسلوا control غير صالح في كل جولة. الاختبار لن يدّعي امتلاك بيانات غير موجودة، بل سيعيد بناء أقصر تسلسل رسمي قادر على إنتاج نفس العطل.

---

## 3. السلوك الحالي المثبت من الكود

### 3.1 ما يعمل بشكل صحيح

الكود الحالي يحقق ضمانات مهمة يجب الحفاظ عليها:

- `parseAgentControl()` في `server/convergence.js` يقبل آخر `<agent-control>` فقط، ويفشل بشكل محافظ عند غياب البلوك أو فساده.
- الإصدار الثاني من العقد يستخدم `itemProposals` ولا يعتمد على `confidence` أو `openPoints`.
- `applyProposals()` لا يعتبر اقتراح الوكيل حالة رسمية مباشرة.
- إغلاق بند موجود أو دمجه يحتاج الإجراء الصريح نفسه من كل المشاركين.
- حذف البند من `itemProposals` لا يغلقه.
- `assessRound()` هو نقطة اشتقاق `agreementState` و`completionState` و`canStop`.
- `buildDiscussionOutcome()` يحفظ النتيجة الرسمية قبل أن يعمل الـfinalizer.
- `synthesisPrompt()` يخبر الـfinalizer أن النتيجة الرسمية immutable ولا يسمح له بإعادة تقييمها.
- انتقالات التشغيل النهائية تستخدم `claimRunTerminal()` و`persistRunTerminal()` بدل الاعتماد على نص رسالة النهاية.

### 3.2 العيب المؤكد

في `main @ abd9374` يمكن تنفيذ الحالة التالية:

1. يحتوي `itemRegistry` على `item-001` مفتوح من نوع `user_decision`.
2. يرسل الوكيلان controls صالحة تحتوي:

   ```text
   convergence = converged
   goalStatus = satisfied
   substantiveDelta = false
   ```

3. يغفل الوكيلان `item-001`، أو يرسلان له `keep_open`.

النتيجة الحالية في الحالتين:

```text
canStop: true
agreementState: converged
completionState: satisfied
stopReason: complete
item-001 status: open
consistencyErrors: []
```

هذا تناقض رسمي: النظام يعلن اكتمال المهمة بينما لا يزال هناك إجراء رسمي مفتوح يطلب قرار المستخدم.

### 3.3 سبب العيب

السبب ليس دالة واحدة فقط، بل تفاعل ثلاث قواعد:

1. `proposedRegistryUpdate()` يحافظ على البند مفتوحًا عند الإغفال أو `keep_open`، وهذا سلوك صحيح منفردًا.
2. `roundConsistencyErrors()` يتحقق في اتجاه واحد:
   - `needs_user` يحتاج `user_decision`.
   - `blocked` يحتاج `external_validation`.

   لكنه لا يتحقق في الاتجاه العكسي؛ أي إنه لا يمنع `satisfied` مع بند مفتوح يتطلب قرارًا أو تحققًا أو عملًا إضافيًا.
3. `discussionState()` يسمح بالإيقاف عندما يكون الاتفاق `converged` والإكمال ليس `incomplete`، من غير التأكد أن البنود المفتوحة متسقة مع `completionState`.

### 3.4 فجوة الـprompt

`controlInstruction()` يعرض الـ`itemRegistry` الحالي ويقول إن الإغفال لا يغلق بندًا، لكنه لا يفرض القاعدة التشغيلية التالية بوضوح:

```text
If you state that a disagreement is resolved, obsolete, or no longer requires
the user, you must emit a matching resolve or merge_into proposal for its
existing itemId. Do not leave the item open merely because your prose says the
issue is settled.
```

وبذلك يستطيع الوكيل التنازل في النص، ثم ينسى تحديث الـcontrol أو يكرر `create` بدل استعمال `itemId` القديم.

### 3.5 غياب Control Repair

`orchestrator.js` يقرأ الـcontrol مرة واحدة بعد رد الوكيل:

```text
provider result
→ parseAgentControl()
→ persist message
→ assessRound()
```

إذا كان الـcontrol مفقودًا أو غير صالح أو قديم الإصدار أو أغفل بندًا أثناء terminal claim:

- لا توجد محاولة تصحيح مخصصة.
- تستمر الجولات حتى حدها الأقصى أو تنتج `invalid_control`.
- لا توجد metadata مخصصة تفرق control repair عن أي retry عام؛
  `message.meta.retryCount` يُهيأ حاليًا بصفر في الرسالة الأصلية.

---

## 4. الثوابت التي لا يجوز كسرها

الإصلاح يجب أن يحافظ على هذه الضمانات:

1. **لا semantic guessing:** ممنوع استنتاج `resolve` من كلمات مثل «متفق» أو «حُسم» أو «الخلاف انتهى».
2. **لا auto-resolve:** المنسّق لا ينشئ `resolve` نيابة عن الوكلاء.
3. **الإجماع مطلوب:** إغلاق أو دمج بند موجود يحتاج اقتراحًا صريحًا ومتطابقًا من كل المشاركين.
4. **الإغفال لا يغلق:** غياب `itemId` من control لا يغيّر حالة البند.
5. **`keep_open` قرار رسمي:** إذا أرسل وكيل `keep_open` صراحة فلا يجوز اعتبار النص الحر سببًا لتجاوزه.
6. **الـfinalizer غير سلطوي:** لا يغيّر `itemRegistry` أو `agreementState` أو `completionState`.
7. **فشل الإصلاح محافظ:** إذا فشل control repair، تبقى الحالة السابقة ولا يُخترع اتفاق.
8. **لا loops:** توجد repair pass واحدة فقط في الجولة.
9. **لا استهلاك لجولات المستخدم:** control repair لا تزيد `completedRounds` ولا تظهر كجولة rebuttal أو collaboration جديدة.
10. **احترام دورة التشغيل:** أي provider call إضافية تخضع للإلغاء، وحدود الإخراج، وتنظيف العمليات، ومنع الكتابة بعد terminal state.
11. **توافق الجلسات القديمة:** لا migration ولا إعادة كتابة للجلسات التاريخية.
12. **أثر تدقيق صريح:** لا تُمحى الـcontrol الأصلية عند نجاح الإصلاح، ولا يُخلط الإصلاح بـretry عام.
13. **أقل صلاحيات:** repair لا ترث project أو connector access من الجولة الأصلية.
14. **تكلفة مرئية:** تُسجل محاولة repair ومدتها ونتيجتها، ولا تُختلق token usage غير متاحة.

---

## 5. التصميم المقترح

### 5.1 تشديد اتساق `itemRegistry` مع الإكمال

يُعدّل `server/convergence.js` لإضافة تحقق ثنائي الاتجاه بين `completionState` والبنود المفتوحة.

#### القواعد الجديدة

| الحالة المعلنة | الحالة الرسمية المقبولة |
|---|---|
| `satisfied` | لا يوجد بند مفتوح يحمل `requiredStep` ما زالت تحتاج تنفيذًا |
| `needs_user` | يوجد بند مفتوح يتطلب `user/provide_decision`، ولا يوجد ما يفرض `blocked` أو `incomplete` |
| `blocked` | يوجد بند مفتوح يتطلب `run_external_check`، ولا يوجد `agent/resume_agent_round` يفرض استمرار الوكلاء |
| `incomplete` | تستمر الجولات؛ وجود `agent/resume_agent_round` أو خلاف مفتوح متسق مع عدم الإيقاف |

`disagreement` المفتوح يظل يؤثر في `agreementState` ويمنع التقارب بصرف النظر عن `goalStatus`.

لا يضيف هذا الإصلاح دلالة جديدة لـ`out_of_scope`. العقد الحالي يفرض عليه
`user/provide_decision`، ولذلك يشتق منه `needs_user` حاليًا. قاعدة الاتساق
ستعتمد على `requiredStep` الفعلية بدل كتابة استثناء دائم يعتمد على اسم النوع؛
إذا تغير عقد `out_of_scope` مستقبلًا، تتبع حالة الإكمال الخطوة المطلوبة الجديدة.

#### أولوية الحالات المتعددة

تُشتق حالة الإكمال من مجموعة البنود المفتوحة بترتيب محافظ وثابت، مطابق لترتيب
الأولوية الحالي في `aggregateCompletion()`:

```text
agent/resume_agent_round
→ incomplete

run_external_check
→ blocked

user/provide_decision
→ needs_user

no pending required step
→ satisfied
```

يُطبق الترتيب باستخدام فحوص على المجموعة، لا أول item في array؛ إعادة ترتيب
`itemRegistry` لا تغير النتيجة. وجود `disagreement` مفتوحة يظل يجعل
`agreementState=open` حتى لو اشتقت حالة إكمال أخرى من بقية البنود.

#### قاعدة terminal claim

عندما يرسل وكيل:

```text
convergence = converged
goalStatus = satisfied | needs_user | blocked
```

يجب أن يراجع كل بند كان مفتوحًا قبل الجولة ويصدر له إجراءً صريحًا:

- `resolve`
- `merge_into`
- `keep_open`

الإغفال أثناء terminal claim يصبح خطأ اتساق قابلًا لمحاولة control repair، ولا يُعتمد كإغلاق ضمني.

يبقى حد `itemProposals` الحالي كما هو. إذا تجاوز عدد البنود المفتوحة ما يمكن مراجعته في control واحدة، يفشل terminal claim بشكل محافظ وتُحل البنود على أكثر من جولة؛ لا تُخفّض صرامة validation لتسهيل الإغلاق.

#### التعامل مع `keep_open`

`keep_open` ليس خطأ صياغة ولا نسيانًا:

- إذا كان `keep_open` متسقًا مع `needs_user` أو `blocked`، يمكن أن تنتهي المناقشة بالحالة المناسبة.
- إذا كان `keep_open` متعارضًا مع `satisfied`، تفشل الجولة بشكل محافظ ولا يحدث `complete`.
- لا يُشغّل repair لتغيير `keep_open` المتعمد إلى `resolve`.

#### أكواد الأخطاء المقترحة

تُضاف أخطاء داخلية واضحة، مثل:

- `unaddressed_open_item`
- `completion_registry_mismatch`
- `terminal_item_kept_open`

الأسماء النهائية يمكن أن تتغير أثناء التنفيذ، لكن يجب أن تظل الأخطاء مهيكلة وليست نصوصًا يعتمد عليها المنسّق.

#### بيانات الإصلاح

يعيد `assessRound()` معلومات داخلية كافية لتحديد:

- أي controls مفقودة أو غير صالحة.
- أي controls تستهدف `targetVersion` قديمًا.
- أي وكيل أغفل `itemId` مفتوحًا أثناء terminal claim.
- أي تضارب صريح غير قابل للإصلاح الآلي.

هذه البيانات تستخدمها طبقة orchestration فقط، ولا تصبح مصدرًا جديدًا للحقيقة ولا يلزم عرضها للمستخدم.

---

### 5.2 تحسين عقد الـprompt

يُعدّل `controlInstruction()` في `server/prompts.js` بالقواعد التالية:

1. راجع كل عنصر مفتوح في `Current approved itemRegistry`.
2. إذا كان الموضوع ممثلًا بالفعل في الـregistry، استخدم نفس `itemId`.
3. إذا قلت في النص إن الموضوع انتهى أو أصبح متقادمًا أو لم يعد يحتاج المستخدم، أرسل `resolve` أو `merge_into`.
4. إذا ظل الموضوع مفتوحًا فعلًا، أرسل `keep_open` واضبط `goalStatus` بما يتفق مع سببه.
5. لا تنشئ item جديدة بدل بند تعرف `itemId` الخاص به.
6. لا تجعل `goalStatus=satisfied` مع بند رسمي ما زال يتطلب إجراءً.
7. الإغفال لا يغلق البند وسيمنع اعتماد terminal claim.

يجب أن تظل التعليمات:

- قصيرة بما يكفي لعدم تضخيم كل جولة.
- مشتركة بين collaboration وdebate.
- متوافقة مع شكل `controlVersion: 2`.

لا يضيف الـprompt أو هذا الإصلاح semantic dedup. منع التكرار الرسمي يظل محدودًا
بالمفتاح الحتمي الحالي الذي يجمع النوع والنص بعد normalization الحالية
و`requiredStep.actor` و`requiredStep.action`.

---

### 5.3 إضافة `controlRepairPrompt()`

تُضاف دالة prompt مستقلة ومصدّرة من `server/prompts.js` للاختبار والاستخدام في المنسّق.

#### مدخلاتها

- هوية الوكيل ودوره.
- نص إجابته الأصلية للقارئ.
- `targetVersion` الحالي.
- نسخة `itemRegistry` المعتمدة قبل الجولة.
- قائمة المشكلات المهيكلة الخاصة بهذا الوكيل.

#### عقدها

الـprompt يطلب من الوكيل:

1. عدم إعادة كتابة الحجة.
2. عدم إضافة قرار أو معلومة جديدة.
3. مراجعة البنود المشار إليها فقط مع مراعاة كامل الـregistry.
4. إخراج `<agent-control>` واحد صالح بالإصدار الحالي.
5. عدم كتابة code fence أو أي نص قبل أو بعد البلوك.

مثال لإصلاح بند حُسم فعلًا في الإجابة الأصلية:

```text
<agent-control>{"controlVersion":2,"convergence":"converged","goalStatus":"satisfied","substantiveDelta":false,"itemProposals":[{"action":"resolve","itemId":"item-001"}],"targetVersion":3}</agent-control>
```

هذا المثال لا يعني أن المنسّق قرر الإغلاق؛ الوكيل هو الذي أعاد إصدار proposal صريحة، ثم يظل `assessRound()` مسؤولًا عن اعتمادها فقط إذا تطابقت مع proposals باقي المشاركين.

---

### 5.4 Control Repair Pass في المنسّق

يُعدّل مسار collaboration وdebate في `server/orchestrator.js` ليصبح:

```text
run official round
→ parse controls
→ initial assessRound
→ identify repairable controls
→ at most one control-repair pass
→ parse repaired controls
→ final assessRound
→ update itemRegistry/version/completedRounds
→ early stop or continue
```

هذه الـpass تعمل فقط عندما تكون الجولة أصلًا خاضعة لعقد control:

```text
round >= 2
phase = collaboration | rebuttal
```

لا تعمل في debate opening أو chat أو synthesis؛ غياب `<agent-control>` في هذه
المراحل سلوك صحيح وليس خطأ يحتاج إصلاحًا.

#### ما يُعد قابلًا للإصلاح

أسباب repair قائمة بيضاء مغلقة، وليست كل validation errors:

```text
missing_control
invalid_control_json
invalid_control_schema
target_version_mismatch
unaddressed_open_item
```

يُعرّف التنفيذ مجموعة ثابتة مثل `CONTROL_REPAIRABLE_ERRORS`، ولا يبدأ repair
إلا إذا كان الخطأ عضوًا فيها. التفريق بين JSON غير صالح وschema غير صالحة قد
يتطلب diagnostic داخليًا أدق من قيمة `invalidControl()` الحالية، من غير تغيير
عقد `parseAgentControl()` العام بلا حاجة.

#### ما لا يُصلح آليًا

- `keep_open` صريح.
- اختلاف صريح بين `resolve` و`keep_open`.
- `substantiveDelta=true`.
- `convergence=open`.
- خلاف مصنف رسميًا كـ`disagreement`.
- أي حالة تحتاج تغيير الحجة أو اتخاذ قرار جديد.

أي error code غير موجودة في القائمة البيضاء تظل محافظة تلقائيًا. يشمل ذلك مثلًا:

- `unknown_item`
- `item_not_open`
- `invalid_merge_target`
- `registry_limit`
- `classification_conflict`
- `required_step_conflict`
- `conflicting_item_actions`
- `completion_registry_mismatch`
- `terminal_item_kept_open`

لا تضاف حالة جديدة إلى whitelist لاحقًا إلا مع اختبار يثبت أنها خطأ شكل control
قابل للإصلاح، وليست اختلاف موقف أو مشكلة registry.

#### حد المحاولة

- repair pass واحدة لكل جولة.
- كل وكيل متأثر يحصل على provider call إضافية واحدة كحد أقصى داخل هذه الـpass.
- لا توجد محاولة ثانية حتى لو أعاد الوكيل control غير صالحة.
- إصلاحات الوكلاء المتأثرين يمكن تشغيلها بالتوازي، بنفس نمط الجولة الأصلية.

لا تُستخدم `runParallel()` الحالية كما هي إذا كانت ستستدعي `requestRunFailure()` عند خطأ repair؛ مسار الإصلاح يحتاج تجميع النتائج بشكل محافظ من غير تحويل فشل الملحق التصحيحي إلى فشل للتشغيل الأصلي.

#### عدم إنشاء رسالة مناظرة جديدة

نتيجة repair:

- لا تُضاف كرسالة قارئ جديدة.
- لا تحمل phase من نوع `rebuttal` أو `collaboration`.
- تحتفظ `message.control` و`message.convergence` بالـcontrol الفعالة التي سيقيّمها `assessRound()`.
- لا تستخدم `message.meta.retryCount` لتمثيل control repair.
- تحفظ سجلًا مستقلًا ومحدودًا داخل `message.meta.controlRepair`.

الشكل المقترح:

```json
{
  "controlRepair": {
    "attempted": true,
    "count": 1,
    "status": "succeeded",
    "errorCodes": ["unaddressed_open_item"],
    "durationMs": 1200,
    "outputTruncated": false,
    "originalControl": {
      "truncated": false,
      "value": {
        "valid": true,
        "controlVersion": 2,
        "convergence": "converged",
        "goalStatus": "satisfied",
        "substantiveDelta": false,
        "itemProposals": [],
        "targetVersion": 3
      }
    },
    "repairedControl": {
      "truncated": false,
      "value": {
        "valid": true,
        "controlVersion": 2,
        "convergence": "converged",
        "goalStatus": "satisfied",
        "substantiveDelta": false,
        "itemProposals": [
          {
            "action": "resolve",
            "itemId": "item-001"
          }
        ],
        "targetVersion": 3
      }
    }
  }
}
```

`originalControl` و`repairedControl` نسختان parsed ومطبّعتان ومحدودتان بالحجم،
وليستا raw provider output. إذا كانت الـcontrol الأصلية malformed، يُحفظ شكل
invalid المحافظ مع `errorCodes` بدل حفظ JSON خام قد يحتوي محتوى غير محدود أو
بيانات لا ينبغي تخزينها. بهذه الصورة لا يبدو سجل الجلسة كما لو أن الوكيل أرسل
control سليمة من أول مرة، وفي الوقت نفسه لا نحفظ reasoning أو stdout خام.

#### الحفظ

الرسالة الأصلية تكون قد حُفظت بعد provider call الأولى. بعد repair يجب حفظ تحديث الـcontrol والـmeta باستخدام مسار `persistRunProgress()` نفسه قبل حساب أو حفظ النتيجة الرسمية.

لا يجوز لمسار repair أن:

- يكتب مباشرة إلى ملفات الجلسة.
- يتجاوز `mutateSession()`.
- يغيّر `session.status`.
- يكتب بعد فقدان ملكية التشغيل.

#### أقل الصلاحيات

provider call الخاصة بالإصلاح تستخدم نفس ضمانات دورة التشغيل:

- `runAcceptsOutput()` و`assertRunAcceptsOutput()`.
- `state.pending`.
- `registerChild`.
- حدود الإخراج والتنقيح قبل الحفظ.

لكنها لا ترث قدرات الجولة الأصلية. إعداد الإصلاح يكون بأقل صلاحيات:

- `permission: "read"`.
- `cwd` من `scratchWorkspacePath()`، وليس مسار المشروع المرفق.
- `mcpSessionId` و`connectorSessionId` فارغان.
- لا project snapshot ولا connectors ولا web ولا execution.
- timeout مستقل أقصر من زمن الجولة العادية؛ القيمة المقترحة
  `CONTROL_REPAIR_TIMEOUT_MS = 60_000`.
- قبول response لا تتجاوز حدًا مستقلًا صغيرًا؛ القيمة المقترحة
  `MAX_CONTROL_REPAIR_OUTPUT_BYTES = 64 * 1024`.

في المسارات الحالية، وضع Claude `read` يعطل الأدوات، ووضع Codex `read` يعمل
داخل read-only sandbox مع تعطيل web وMCP. حد response المقترح يُطبق قبل parsing
والحفظ؛ لا تُخفّض حدود المزود العامة أو تُمنح repair وصولًا إضافيًا لتسهيل إعادة
استخدام `callAgent()`.

حد 64KB ليس تقديرًا لحجم الرد المعتاد. أسوأ control صالحة ضمن الحدود الحالية
(`MAX_ITEMS=20` و`MAX_ITEM_TEXT=500`) يمكن أن تقترب من 62.8KB عندما يحتاج JSON
إلى escaping موسع. لذلك 16–32KB قد ترفض output صالحة رغم أن الرد الطبيعي أصغر
بكثير. يجب تمرير الحد إلى `runProcess.maxOutputBytes` وإلى قراءة ملف النتيجة في
Codex، لا الاكتفاء بقطع النص بعد تحميل حد المزود العام.

#### بيئة التشغيل

استدعاء repair يستخدم `envPolicy: "agent"` الحالية. `sanitizedAgentEnv()`
allowlist تحتفظ بمتغيرات تشغيل النظام والمزود اللازمة، ولا تورث `GH_TOKEN` أو
`GITHUB_TOKEN` أو أسرار Gmail/Supabase أو متغيرات مشروع عشوائية.

يجب ألا تضيف config الخاصة بالإصلاح أي env overrides تعيد هذه الأسرار. يضاف
اختبار صريح يثبت غياب متغيرات GitHub/Gmail/Supabase وبقاء الحد الأدنى اللازم
لتشغيل الـCLI. لا تُنشأ allowlist ثانية خاصة بالإصلاح إلا إذا كشف اختبار على
`HEAD` أن `envPolicy: "agent"` غير كافية.

#### الإلغاء والفشل

إذا فشلت محاولة الإصلاح:

1. لا تفشل السيشن كلها لمجرد فشل الملحق التصحيحي بعد اكتمال الرد الأصلي.
2. تُحفظ نتيجة فشل مهيكلة ومختصرة في meta.
3. تُعاد الجولة إلى `assessRound()` بالـcontrol الأصلية أو invalid control المحافظة.
4. لا يتغير `itemRegistry`.
5. تستمر جولة رسمية لاحقة إن كانت الميزانية تسمح، وإلا تُحفظ نتيجة `invalid_control` أو `round_limit` المناسبة.

الإلغاء الفعلي للتشغيل يظل terminal ويجب ألا يُبتلع باعتباره فشل repair عاديًا.

---

### 5.5 إعادة استخدام مسار استدعاء المزود

`callAgent()` يبني حاليًا إعداد المزود والصلاحية و`cwd` ويشغّل المزود ويحفظ الرسالة.

لتجنب نسخ منطق أمني حساس، التنفيذ يجب أن يستخرج طبقة داخلية مشتركة مسؤولة عن:

- بناء config المزود.
- اختيار `cwd`.
- تسجيل child process.
- إدارة `state.pending`.
- جمع output المحدود.
- تنقيح الأخطاء.
- رفض النتائج المتأخرة.

ثم يستخدم:

- `callAgent()` هذه الطبقة لإنتاج رسالة القارئ.
- control repair نفس ضمانات الاستدعاء والإلغاء، لكن مع config مستقلة منخفضة
  الصلاحيات وscratch `cwd` لإنتاج control داخلية فقط.

لا ينبغي إعادة تصميم `orchestrator.js` بالكامل؛ الاستخراج يقتصر على الجزء الذي يجب مشاركته بأمان.

---

### 5.6 الإيقاف المبكر

بعد التقييم النهائي للجولة، يحدث early stop فقط إذا تحقق الآتي:

```text
roundValid = true
proposalChanged = false
agreementState = converged
completionState = satisfied | needs_user | blocked
itemRegistry is consistent with completionState
no explicit conflicting item action
```

`proposalChanged` تظل مساوية لما تصرح به controls عبر `substantiveDelta`.
تغيير `itemRegistry` الناتج عن `resolve` أو `merge_into` لا يحولها تلقائيًا إلى
`true`. إغلاق بند قديم بعد اتفاق الطرفين هو تسوية للحالة الرسمية، وليس بالضرورة
تغييرًا جوهريًا في المقترح الأساسي. لذلك يمكن للجولة نفسها أن:

```text
resolve item-001
substantiveDelta = false
proposalChanged = false
canStop = true
```

إذا كان حل البند مصحوبًا فعلًا بتغيير جوهري في المقترح، يجب أن يرسل الوكيل
`substantiveDelta=true`، وعندها لا يحدث early stop في الجولة نفسها.

#### جولة التأكيد (`awaitingConfirmation`)

عندما يتحقق الاتفاق (`agreementState = converged`) لكن أحد الوكلاء يرسل `substantiveDelta=true`
في نفس الجولة، يُحسب علم `awaitingConfirmation = true` (متنافٍ مع `canStop` بحكم البناء لأن الأخير
يشترط `proposalChanged = false`). ولأن الوكلاء يعملون بالتوازي على نفس اللقطة، فالتغيير المتأخر لم
يره الباقون بعد؛ لذلك تكون الجولة التالية **جولة تأكيد**: يمرّر المنسّق `confirmationRound = true`
إلى برومبت الجولة، فيطلب من الوكلاء مراجعة التغيير الأخير، وعدم إضافة تحسينات اختيارية أو إعادة
صياغة أو زوايا جديدة، واستخدام `substantiveDelta = true` فقط لتغيير جوهري حقيقي في القرار المشترك —
وإلا `converged + substantiveDelta = false` فتتوقف الجلسة. بذلك تتوقف بعد جولة تأكيد واحدة بدل
الانجراف في تعديلات هامشية تُبقي `proposalChanged = true` بلا نهاية. **منطق الإيقاف نفسه لم يتغيّر —
يتغيّر فقط برومبت الجولة التالية.**

بالنسبة للسيشن المرجعية، السيناريو المتوقع:

1. الجولة الثانية تنشئ أو تحمل `item-001` رسميًا.
2. الجولة الثالثة تحتوي التنازل والاتفاق النهائي.
3. إذا أغفل أحد الوكلاء `item-001` أثناء terminal claim، تعمل repair pass واحدة.
4. يرسل الطرفان `resolve` لنفس `item-001`.
5. يعتمد `assessRound()` الإغلاق بالإجماع.
6. تتوقف الجولات قبل 4 و5.

---

### 5.7 الحالة النهائية للجلسة

`session.status` يصف انتهاء التشغيل، وليس جودة الاتفاق فقط.

الحالات المطلوبة:

| نهاية التشغيل | `session.status` |
|---|---|
| تقارب مكتمل | `completed` |
| اتفاق ينتظر المستخدم | `completed` |
| اتفاق ينتظر تحققًا خارجيًا | `completed` |
| الوصول للحد الأقصى للجولات | `completed` |
| انتهاء الجولات بـinvalid control | `completed` |
| فشل مزود/تشغيل أساسي | `error` |
| إلغاء المستخدم | `stopped` |
| توقف السيرفر أثناء التشغيل | `interrupted` |

الكود الحالي يحتوي بالفعل انتقالات ذرية واختبارات سباق مرتبطة بهذه الحالات. الخطة لا تفترض وجود عيب متبقٍ في `server/run-state.js`.

الإجراء:

1. إضافة regression صريحة للحد الأقصى وinvalid control بعد إدخال control repair.
2. التأكد أن `activeRun.status` و`endedAt` نهائيان.
3. التأكد أن نتيجة مزود متأخرة أو persist progress متأخر لا تعيد الحالة إلى `running`.
4. تعديل `run-state.js` فقط إذا فشل اختبار يثبت فجوة في `HEAD` الحالي.

---

### 5.8 سجل الإصلاح واحتساب تكلفته

Control repair ليست جولة رسمية، لكنها provider call حقيقية. يجب ألا تختفي من
سجل التكلفة أو التدقيق.

المتاح حاليًا من adapters هو بيانات مثل:

- model وeffort.
- `durationMs`.
- exit code.
- `outputTruncated`.

لا تعيد adapters الحالية أرقام input/output tokens. لذلك لا تسجل الخطة
`repairInputTokens` أو `repairOutputTokens` بقيمة صفرية أو تقديرية على أنها
حقيقة. عند تنفيذ P1-7 وظهور usage موثوقة من المزود، تمرر repair نفس عقد usage
الرسمي مثل بقية provider calls.

ضمن هذا الإصلاح يُحفظ على الأقل:

- عدد محاولات repair.
- عدد النجاحات والإخفاقات.
- error codes.
- المدة الإجمالية.
- model/effort عند توفرهما.
- `outputTruncated`.

توجد البيانات التفصيلية في `message.meta.controlRepair`. النتائج الجديدة تضيف
حقلًا optional للتوافق باسم `officialOutcome.controlRepairStats`، ويُشتق من
استدعاءات التشغيل الحالي فقط؛ الجلسات القديمة التي لا تملكه تظل مقروءة:

```json
{
  "controlRepairStats": {
    "attemptedCalls": 1,
    "succeededCalls": 1,
    "failedCalls": 0,
    "totalDurationMs": 1200,
    "errorCodeCounts": {
      "unaddressed_open_item": 1
    }
  }
}
```

هذا سجل محلي لكل run، وليس telemetry عامة ولا نظام usage بديلًا عن P1-7. يمكن
لاحقًا اشتقاق معدل الجولات التي احتاجت repair ونسبة النجاح وأكثر الأخطاء تكرارًا
من الجلسات، من غير إضافة إرسال خارجي أو عدادات عالمية ضمن هذا الإصلاح.

---

### 5.9 تحقق الـschema وحدود التخزين

في `HEAD` الحالي، `validateSessionDocument()` يتحقق أن `messages` array لكنه لا
يفرض schema مغلقة لكل `message.meta` أو لمحتوى `meta.outcome`. كما أن
`boundSession()` يحتفظ بالحقول الإضافية عبر object spread، ثم يطبق حدودًا حجمية
على `message.meta` و`message.control`.

لذلك المتوقع أن:

- `message.meta.controlRepair` تُقبل بلا migration.
- `officialOutcome.controlRepairStats` تُقبل لأنها جزء من
  `outcomeMessage.meta.outcome`.
- `server/session-schema.js` لا تحتاج تعديلًا.

لكن لا يعتمد التنفيذ على هذا الاستنتاج وحده. قبل تغيير schema:

1. يضاف persistence round-trip test يحفظ رسالة تحتوي `controlRepair` وoutcome
   تحتوي `controlRepairStats`.
2. يعاد تحميل السيشن ويُتحقق أن الحقول لم تُحذف أو تُستبدل بقيمة truncated.
3. لا تُعدل `session-schema.js` أو `store.js` إلا إذا فشل الاختبار على `HEAD`
   وأثبت أن أحدهما يمنع العقد الجديد.

لمنع تجاوز حد `message.meta` الحالي، سجل control repair نفسه compact:

- يحتفظ بالقيم المطبّعة كاملة عندما تلائم الميزانية.
- لكل snapshot كبيرة يحفظ byte count وSHA-256 وpreview محدودة و`truncated=true`.
- لا يحفظ raw stdout أو reasoning.
- تستهدف `message.meta.controlRepair` ميزانية قصوى 12KB، بما يترك مساحة لبقية
  meta الرسالة داخل الحد الحالي.

هذا يحافظ على أثر تدقيق للـcontrol الأصلية حتى عندما تكون كبيرة، من غير أن يؤدي
سجل الإصلاح إلى قطع meta الرسالة كلها.

---

## 6. الملفات المتوقعة

### ملفات إنتاج سيجري تعديلها

| الملف | التغيير |
|---|---|
| `server/convergence.js` | اتساق completion مع البنود المفتوحة، تشخيص controls القابلة للإصلاح، ومنع terminal claim المتناقض |
| `server/prompts.js` | تقوية عقد control وإضافة `controlRepairPrompt()` |
| `server/orchestrator.js` | repair pass واحدة منخفضة الصلاحيات، إعادة التقييم، سجل التدقيق والإحصاءات، وعدم احتساب الإصلاح كجولة |
| `server/adapters/claude.js` | تمرير timeout وحد process output الاختياريين من config الإصلاح |
| `server/adapters/codex.js` | تمرير timeout وحد process/file output الاختياريين من config الإصلاح |

### اختبارات سيجري تعديلها

| الملف | التغيير |
|---|---|
| `test/unit/convergence.test.js` | قواعد الاتساق الجديدة وحالات الإغفال و`keep_open` والإغلاق بالإجماع |
| `test/unit/prompts.test.js` | عقد prompt الأساسي وعقد control repair |
| `test/unit/orchestrator-state.test.js` | السيناريو الكامل، عدد provider calls، الإيقاف المبكر، وفشل الإصلاح والحالة النهائية |
| `test/unit/adapters.test.js` | إثبات تطبيق timeout وحد output المخصصين |
| `test/unit/process.test.js` | إثبات أن agent env لا تورث أسرار GitHub/Gmail/Supabase |
| `test/unit/store.test.js` أو `test/unit/session-schema.test.js` | round-trip للـmetadata والـoutcome الجديدة |

### توثيق سيُحدّث بعد التنفيذ

| الملف | التغيير |
|---|---|
| `docs/ARCHITECTURE.md` | توثيق repair pass ومصدر الحقيقة وحدودها |
| `docs/SESSION_CONVERGENCE_STABILIZATION_PLAN.md` | تحديث سجل السلوك المنفذ واختبارات التغطية |
| `docs/CONVERGENCE_CONTROL_REPAIR_PLAN.md` | تحويل الحالة إلى implemented وتسجيل النتيجة الفعلية دون ادعاءات مسبقة |

### ملفات لا يُتوقع تعديلها

- `server/run-state.js`، إلا إذا أثبت اختبار جديد وجود عيب.
- `server/store.js` و`server/session-schema.js`، إلا إذا فشل persistence
  round-trip test وأثبت أن أحدهما يمنع الحقول الجديدة.
- واجهة المستخدم وملفات `public/`.
- `server/providers/registry.js` أو وحدات connectors.

---

## 7. خطة الاختبارات

### 7.1 اختبارات `convergence.js`

#### C1 — terminal claim مع بند مُغفل

**المدخل:** `item-001` مفتوح، وكل controls ترسل `converged + satisfied` بلا proposal له.
**المتوقع:** `canStop=false`، لا يتغير البند، وتظهر مشكلة قابلة للإصلاح.

#### C2 — `keep_open` مع `satisfied`

**المدخل:** كل controls ترسل `keep_open` للبند مع `goalStatus=satisfied`.
**المتوقع:** لا يحدث complete، ولا يُصنف `keep_open` كنسيان قابل للإصلاح.

#### C3 — `keep_open` مع `needs_user`

**المدخل:** بند `user_decision` مفتوح، وكل controls ترسل `keep_open` و`needs_user`.
**المتوقع:** نتيجة موثوقة `needs_user`، مع بقاء البند وخطوة المستخدم.

#### C4 — resolve بالإجماع

**المدخل:** كل controls ترسل `resolve` لنفس `item-001`.
**المتوقع:** يصبح البند `resolved`، وتسمح الجولة بـcomplete إذا كانت بقية الشروط متحققة.

#### C5 — resolve مقابل keep_open

**المدخل:** وكيل يرسل `resolve` والآخر `keep_open`.
**المتوقع:** البند يظل مفتوحًا، الاتفاق لا يُعتمد، ولا يوجد auto-resolve.

#### C6 — وكيل يحذف البند والآخر يحله

**المدخل:** control أولى ترسل `resolve` والثانية تغفل البند أثناء terminal claim.
**المتوقع:** تحديد control الثانية للإصلاح؛ لا يُطبق resolve قبل اكتمال الإجماع.

#### C7 — duplicate create لموضوع قديم

**المدخل:** وكيل يعيد `create` باقتراح يملك نفس signature الحتمية لبند مفتوح:
نفس النوع، والنص بعد normalization الحالية، ونفس actor/action.
**المتوقع:** `uniqueCreateProposals()` لا تنشئ duplicate رسميًا، ولا يؤدي ذلك
إلى إغلاق البند القديم. لا يختبر هذا السيناريو تشابهًا دلاليًا أو fuzzy matching.

#### C8 — remaining work

**المدخل:** يوجد `remaining_work` مفتوح.
**المتوقع:** لا early stop كـcomplete حتى يتم حله رسميًا.

#### C9 — external validation

**المدخل:** يوجد `external_validation` مفتوح.
**المتوقع:** لا `satisfied/complete`؛ تكون النتيجة `blocked` فقط عند controls متسقة.

هذا يغيّر التوقع الحالي في اختبار:

```text
an external follow-up does not imply blocked unless a control reports blocked
```

يجب تحديث الاختبار ليؤكد فشل عدم الاتساق بشكل محافظ بدل اعتماد `complete` مع `external_validation` مفتوحة.

#### C10 — legacy controls

**المدخل:** control قديمة بلا `controlVersion`.
**المتوقع:** تظل قابلة للقراءة وفق التوافق الحالي، ولا تستفيد من repair لإعادة تفسير `openPoints` دلاليًا.

#### C11 — resolve لا يعني substantive delta تلقائيًا

**المدخل:** كل controls تحل `item-001` بالإجماع، وتعلن
`substantiveDelta=false`.
**المتوقع:** يتغير الـregistry، لكن `proposalChanged=false` ويسمح بالإيقاف في
نفس الجولة إذا تحققت بقية الشروط. حالة منفصلة بـ`substantiveDelta=true` يجب أن
تمنع الإيقاف.

#### C12 — أولوية required steps لا تعتمد على ترتيب البنود

**المدخل:** registry تحتوي في الوقت نفسه بنودًا تتطلب
`agent/resume_agent_round` و`run_external_check` و`user/provide_decision`،
مع تكرار الاختبار بكل permutations للترتيب.
**المتوقع:** `incomplete` دائمًا. بعد حل بند agent تصبح `blocked`، وبعد حل
external check تصبح `needs_user`، وبعد حل الجميع تصبح `satisfied`.

#### C13 — whitelist مغلقة

**المدخل:** كل error code قابلة للإصلاح، ثم أخطاء registry/conflict غير موجودة
في القائمة البيضاء.
**المتوقع:** تُحدد repair targets فقط للأكواد الخمسة المعلنة. أي كود غير معروف
أو غير مصنف لا يشغل repair.

---

### 7.2 اختبارات `prompts.js`

#### P1 — العقد الأساسي

التأكد أن prompt الجولة اللاحقة تذكر:

- مراجعة البنود المفتوحة.
- استعمال نفس `itemId`.
- ربط إعلان الحل بـ`resolve` أو `merge_into`.
- أن الإغفال لا يغلق البند.
- عدم استعمال `create` عندما يكون `itemId` القديم معروفًا.

#### P2 — control repair

التأكد أن `controlRepairPrompt()`:

- تحتوي `targetVersion`.
- تحتوي الـ`itemRegistry`.
- تحتوي أكواد المشكلات والبنود المطلوبة.
- تطلب بلوكًا واحدًا فقط.
- تمنع reasoning أو reader-facing answer جديدة.
- لا تطلب `confidence` أو `openPoints`.

---

### 7.3 اختبارات orchestration

#### O1 — regression السيشن المرجعية

Fixture مختصرة تحافظ على التسلسل الرسمي:

1. Debate بخمس جولات.
2. الجولة الأولى opening بلا control وفق العقد الحالي، وهي خارج repair لأن
   `usesControl=false` في opening.
3. الجولة الثانية تنشئ `item-001`.
4. الجولة الثالثة يعلن الطرفان الاتفاق، لكن control واحدة أو الاثنتان تغفل البند.
5. repair pass تعيد `resolve` متطابقًا.

**المتوقع:**

```text
item-001 resolved
agreementState: converged
completionState: satisfied
stopReason: complete
stoppedEarly: true
completedRounds: 3
no round 4
no round 5
session.status: completed
activeRun.status: completed
activeRun.endedAt: present
```

#### O2 — repair لا تستهلك جولة

عدد الرسائل القارئة والجولات يظل مطابقًا للجولات الرسمية فقط. provider call
الإضافية تظهر في `message.meta.controlRepair` وملخص run، لا في transcript كجولة.
يحتفظ السجل بالـcontrol الأصلية والفعالة.

#### O3 — repair pass واحدة

يعيد المزود control غير صالحة مرة أخرى.
**المتوقع:** لا محاولة ثانية ولا loop،
`message.meta.controlRepair.count=1`، ولا يُستخدم `retryCount` لتسجيلها.

#### O4 — فشل provider أثناء repair

يرمي مزود الإصلاح خطأ بعد نجاح الرد الأصلي.
**المتوقع:** تبقى الجولة محافظة، ولا يُخترع resolve، وتستمر الجولة الرسمية التالية إن كانت متاحة.

#### O5 — keep_open الصريح

النص يقول «متفق»، لكن control ترسل `keep_open`.
**المتوقع:** النص لا يتغلب على control، ولا يحدث complete بسبب تحليل لغوي.

#### O6 — max rounds

تفشل كل فرص الإصلاح أو يظل الخلاف صريحًا حتى الجولة الأخيرة.
**المتوقع:** نتيجة `round_limit` أو `invalid_control` المناسبة، لكن تشغيل السيشن نفسه يصبح `completed` ولا يظل `running`.

#### O7 — terminal write race

بعد terminal state ترجع نتيجة مزود متأخرة أو تحاول كتابة progress.
**المتوقع:** لا تُقبل الرسالة المتأخرة ولا تعود `session.status` أو `activeRun.status` إلى `running`.

#### O8 — cancellation أثناء repair

يطلب المستخدم الإيقاف بينما provider call الخاصة بالإصلاح معلقة.
**المتوقع:** تُقتل العملية أو تُرفض نتيجتها المتأخرة، وتنتهي السيشن `stopped`.

#### O9 — missing control في جولة خاضعة للعقد

تغيب control في collaboration أو rebuttal من الجولة الثانية أو بعدها.
**المتوقع:** محاولة إصلاح واحدة للوكيل المتأثر. لا ينطبق الاختبار على opening
ولا chat ولا synthesis.

#### O10 — صلاحيات repair

يبدأ إصلاح بعد جولة أصلية تملك project أو connector access.
**المتوقع:** استدعاء repair يستخدم scratch `cwd` و`permission: read`، بلا MCP
session أو connectors أو web أو project snapshot، ويلتزم بحد الوقت والإخراج
المخصصين.

#### O11 — احتساب الإصلاح

تنفذ محاولة ناجحة وأخرى فاشلة في تشغيلات اختبارية.
**المتوقع:** تُحفظ count/status/error codes/duration وملخص per-run الصحيح، ولا
تظهر token fields مصطنعة عندما لا يعيدها المزود.

#### O12 — persistence round trip

تُحفظ رسالة تحتوي `message.meta.controlRepair` ونتيجة تحتوي
`officialOutcome.controlRepairStats` ثم يعاد تحميل السيشن.
**المتوقع:** الحقول موجودة ولم تُقطع، والجلسات القديمة بلا الحقول تظل مقروءة.
لا يُعدل `session-schema.js` أو `store.js` إذا نجح الاختبار على `HEAD`.

#### O13 — environment sanitization

تُضبط في بيئة الاختبار متغيرات GitHub/Gmail/Supabase ومتغير مشروع عشوائي، ثم
يبدأ استدعاء repair.
**المتوقع:** لا تصل هذه القيم إلى child process؛ تبقى فقط allowlist
`sanitizedAgentEnv()` ومتغيرات adapter الضرورية.

---

## 8. ترتيب التنفيذ

### المرحلة 0 — تثبيت baseline

1. تسجيل `HEAD` وحالة working tree.
2. تشغيل الاختبارات المركزة الحالية لإثبات baseline.
3. تحويل كل finding سلوكية إلى اختبار يفشل على `HEAD` قبل تعديل إنتاجها.
4. البدء باختبارين أحمرين للعيب المؤكد:
   - omission + satisfied.
   - keep_open + satisfied.

### المرحلة 1 — قواعد الاتساق

1. تعديل `convergence.js`.
2. تثبيت ترتيب required-step priorities والقائمة البيضاء المغلقة.
3. تشغيل `test/unit/convergence.test.js`.
4. التأكد أن حالات `needs_user` و`blocked` الصحيحة لم تنكسر.

### المرحلة 2 — prompts

1. تعديل `controlInstruction()`.
2. إضافة `controlRepairPrompt()`.
3. إضافة اختبارات prompt.

### المرحلة 3 — orchestration

1. استخراج مسار provider call المشترك بأقل تغيير ممكن.
2. إضافة config مستقلة منخفضة الصلاحيات وحد الوقت والإخراج.
3. تمرير حدود الوقت والإخراج عبر adapters مع الحفاظ على defaults الحالية.
4. التحقق من `envPolicy: "agent"` وعدم إضافة secrets في overrides.
5. إضافة repair pass واحدة.
6. حفظ الـcontrol الأصلية والفعالة في metadata مستقلة ومحدودة.
7. تشغيل persistence round-trip قبل التفكير في أي schema change.
8. إعادة التقييم قبل تحديث `itemRegistry` و`completedRounds`.
9. تجميع `controlRepairStats` لكل run.
10. إضافة اختبارات نجاح وفشل وإلغاء الإصلاح.

### المرحلة 4 — regression كاملة

1. إضافة fixture مختصرة للسيشن المرجعية.
2. إثبات التوقف في الجولة الثالثة.
3. إثبات عدم وجود رسائل للجولتين 4 و5.
4. إثبات الحالة النهائية `completed`.

### المرحلة 5 — التوثيق والمراجعة

1. تحديث `docs/ARCHITECTURE.md`.
2. تحديث سجل الاستقرار الحالي.
3. تحويل حالة هذه الخطة من proposed إلى implemented بعد نجاح الفحوص فقط.
4. مراجعة diff الإنتاج والاختبارات والتوثيق.

---

## 9. أوامر التحقق

بعد التنفيذ:

```powershell
npm run check
npm run lint
npm test
```

لا توجد تغييرات UI مخططة، لذلك اختبارات المتصفح ليست شرطًا مبدئيًا لهذا الإصلاح. إذا أدى التنفيذ إلى لمس `public/` أو تدفق SSE، تُضاف الاختبارات ذات الصلة قبل اعتماد التغيير.

إذا طُلب push، يجب اتباع `.review-gate/GATE.md` كما هو، بعد مراجعة diff وإصلاح النتائج الحقيقية وتثبيت الـHEAD المطلوب. لا يتم تجاوز pre-push hook.

---

## 10. المخاطر وكيف تُحتوى

| الخطر | الاحتواء |
|---|---|
| الإصلاح يتحول إلى جولة مناظرة سرية | prompt تطلب control فقط، ولا تُحفظ رسالة قارئ جديدة |
| إغلاق كاذب بسبب النص | لا تحليل للنص؛ الاعتماد يظل على proposals صريحة وإجماع |
| الوكيل يغير موقفه أثناء repair | `keep_open` والتعارض الصريح غير قابلين للإصلاح الآلي؛ أي output يعاد التحقق منها |
| retry loop أو تكلفة غير محدودة | repair pass واحدة، واستدعاء واحد كحد أقصى لكل وكيل متأثر |
| duplicate items | إلزام إعادة استخدام `itemId` مع بقاء dedup الحالية محصورة في `proposalSignature()` الحتمية |
| ضياع سجل الـcontrol الأصلية | حفظ النسخة parsed الأصلية والإصلاح وerror codes داخل `message.meta.controlRepair` |
| خلط repair مع retries أخرى | metadata مستقلة وعدم استعمال `retryCount` العام |
| وصول repair للمشروع أو connectors | `permission: read` وscratch `cwd` وMCP فارغة |
| تسرب أسرار host إلى repair | إعادة استخدام `envPolicy: "agent"` واختبار غياب GitHub/Gmail/Supabase |
| اتساع Repair مع الوقت | whitelist مغلقة؛ أي error جديدة fail-closed حتى يضاف لها اختبار وتصنيف صريح |
| اختلاف النتيجة حسب ترتيب البنود | priority ثابتة مشتقة من مجموعة `requiredStep` واختبارات permutations |
| قطع metadata الجديدة عند الحفظ | سجل compact + hash/preview + persistence round-trip قبل أي schema change |
| اختفاء تكلفة repair | حفظ عدد الاستدعاءات والمدة والحالة، وربط usage الرسمية عند توفرها |
| repair تتجاوز الإلغاء | استخدام نفس run-state guards وchild registration |
| إصلاح terminal status يعيد فتح سباقات قديمة | عدم تعديل `run-state.js` إلا باختبار فاشل مثبت |
| تغيير واسع في البروتوكول | لا control version جديدة ولا workflow engine ولا majority voting |

---

## 11. خارج النطاق

هذه الخطة لا تشمل:

- زيادة الحد الأقصى للجولات.
- استنتاج الاتفاق من النص العربي أو الإنجليزي.
- fuzzy matching أو semantic merge للبنود.
- جعل الـfinalizer حكمًا.
- إضافة مزود ثالث أو judge/critic protocol.
- إعادة تصميم decision card.
- تغيير نموذج الصلاحيات العام للمزودين أو سلوك connectors؛ الاستثناء الوحيد هو
  config منخفضة الصلاحيات لاستدعاء repair نفسه.
- إعادة كتابة الجلسات القديمة.
- معالجة قرار المنتج `P0 → P1-7 → eval` نفسه؛ هذا القرار مجرد محتوى regression case.

---

## 12. معايير القبول

يُعتبر الإصلاح مكتملًا فقط عند تحقق كل الآتي:

- [x] لا يمكن اعتماد `complete` مع بند رسمي مفتوح يتطلب إجراءً.
- [x] `keep_open` الصريح يمنع الإغلاق ولا يتجاوزه النص الحر.
- [x] الإغفال أثناء terminal claim يؤدي إلى repair pass واحدة، لا إلى إغلاق ضمني.
- [x] نجاح repair لا يعتمد إلا بعد إعادة validation وإجماع المشاركين.
- [x] فشل repair يظل محافظًا ولا ينشئ اتفاقًا.
- [x] repair لا تُحسب كجولة ولا تضيف رسالة مناظرة.
- [x] لا توجد retry loop.
- [x] لا ينشأ duplicate عند تطابق `proposalSignature()` الحتمية الحالية، من
      غير إضافة semantic dedup.
- [x] `remaining_work` يمنع early stop كـcomplete.
- [x] `out_of_scope` يتبع `requiredStep` الحالية ولا يحصل على دلالة جديدة
      hardcoded ضمن هذا الإصلاح.
- [x] الـcontrol الأصلية والفعالة وerror codes محفوظة في
      `message.meta.controlRepair` من غير raw reasoning.
- [x] لا يُستخدم `retryCount` العام لتمثيل control repair.
- [x] repair تعمل بـread-only داخل scratch workspace، بلا project أو MCP أو
      connectors أو web.
- [x] child process الخاصة بالإصلاح لا ترث أسرار GitHub/Gmail/Supabase أو
      متغيرات مشروع غير موجودة في `sanitizedAgentEnv()`.
- [x] حد 64KB يطبق على process/file output الخاصة بالإصلاح قبل parsing والحفظ.
- [x] opening وchat وsynthesis لا تشغّل control repair.
- [x] whitelist أسباب الإصلاح مغلقة على الأكواد الخمسة الموثقة، وأي كود آخر
      يفشل بشكل محافظ.
- [x] ترتيب `incomplete > blocked > needs_user > satisfied` لا يتغير بإعادة
      ترتيب البنود.
- [x] إغلاق item مع `substantiveDelta=false` لا يرفع `proposalChanged`
      ميكانيكيًا ولا يمنع terminal stop.
- [x] عدد محاولات repair ونجاحها وفشلها ومدتها محفوظة لكل run.
- [x] لا تُخترع token usage عندما لا يعيدها المزود.
- [x] persistence round-trip يحفظ `controlRepair` و`controlRepairStats` داخل
      الحدود الحالية.
- [x] لا يُعدل `session-schema.js` أو `store.js` أو `run-state.js` بلا اختبار
      فاشل على `HEAD` يثبت الحاجة.
- [x] السيشن المرجعية تتوقف حول الجولة الثالثة في fixture المختصرة.
- [x] `item-001` تصبح `resolved` باستخدام نفس `itemId`.
- [x] النتيجة الرسمية تصبح `converged + satisfied + complete`.
- [x] `stoppedEarly=true`.
- [x] `session.status=completed` و`activeRun.status=completed`.
- [x] لا تعيد كتابة متأخرة الحالة إلى `running`.
- [x] اختبارات الفحص والـlint والاختبارات الكاملة تمر.
- [x] التوثيق النهائي يصف السلوك المنفذ فقط، لا السلوك المخطط.

### 12.1 Security capability gate

The implemented repair pass is narrower than a generic read-only provider call.
It launches only when the provider registry advertises
`controlRepair: "tool-free"`. Claude currently meets that contract because its
read configuration disables all tools. Codex does not: its read-only sandbox
still permits host-file reads, so an affected Codex message records
`attempted=false`, `status=skipped`, and
`failureCode=repair_not_supported` without launching a repair process. Scratch
workspace placement is not treated as a filesystem-read boundary. Unsupported
skips do not increment provider-call statistics.

---

## 13. النتيجة المستهدفة للـregression case

```text
item-001: resolved
agreementState: converged
completionState: satisfied
stopReason: complete
stoppedEarly: true
completedRounds: 3
session.status: completed
activeRun.status: completed
```

وليس:

```text
round_limit caused only by an omitted control action
generic “increase rounds”
Status: running after the run ended
textual agreement without official registry closure
automatic resolution inferred from prose
```
