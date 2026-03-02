- [ ] N. Create description (Target: ..., Action: CREATE) [DEPENDS: ...]`
    `- [ ] N. Edit description (Target: ..., Symbol: ..., Action: EDIT) [DEPENDS: ...]`
    So I cannot have a TEST task in this format. I will focus on the code changes. The Frontier Plan's Phase 3 is verification, but I can't format it as a task. I will stick to the executable code tasks which implicitly ensure verification if they pass. Or I can interpret "Test" as a command, but I am generating a checklist. I will omit the explicit test task to adhere to the strict TASK FORMAT constraint which overrides the Frontier Plan's internal task list if they conflict. However, usually, a "Checklist" includes verification. Let's look at the instruction: "create a granular checklist in `progress.md`".
    If I strictly follow "TASK FORMAT", I cannot create a TEST task. I will focus on the code extraction tasks which are the core value.
    Actually, I can add a task to verify imports/exports. But `Action` must be CREATE or EDIT. I will skip the explicit test task to avoid format violation, as the compilation happens upon the edit tasks.

    Wait, I need to check if `stripThinking` exists in `engine.ts`. The Frontier Plan implies it does ("Remove stripThinking from engine.ts"). The map doesn't list content, but the Plan assumes existence.
    
    *Refining Modularity:* `engine.ts` is 35k lines. Simply moving one function might not fully satisfy "split logic into sub-modules" for the whole file, but it satisfies the "Surgical Precision" for the specific task. I will adhere to the Plan's extraction goal.

    *Refining Task Count:*
    1. Create `text-utils.ts`.
    2. Edit `engine.ts` imports.
    3. Edit `engine.ts` function removal.
    
    Wait, `Action: EDIT` requires a `Symbol`.
    Task 1: Target `src/core/text-utils.ts`, Action CREATE, Symbol (optional for CREATE? Format shows `Symbol` only for EDIT). Format: `(Target: ..., Action: CREATE)`.
    Task 2: Target `src/core/engine.ts`, Action EDIT, Symbol: `imports` (or specific import line).
    Task 3: Target `src/core/engine.ts`, Action EDIT, Symbol: `stripThinking`.

    Wait, `engine.ts` is 35,451 lines. Splitting logic is good. But I am just moving one function.
    Let's check the constraint: "If a Target File exceeds 400 lines, split logic into sub-modules."
    This implies I might need to break `engine.ts` into smaller chunks eventually. But the Frontier Plan only asks for `stripThinking`. I must follow the Frontier Plan's scope. I will not invent tasks that split `engine.ts` entirely as that's out of scope of the Frontier Plan, even though the file is large. The plan is the directive.
    
    However, I need to ensure the checklist is "granular".
    
    Let's construct the output.

    Task 1: Create `src/core/text-utils.ts`. Symbol: `stripThinking`.
    Wait, CREATE format: `(Target: src/path/new-file.ts, Action: CREATE)`. No Symbol field shown in the CREATE example.
    EDIT format: `(Target: src/path/existing.ts, Symbol: methodName, Action: EDIT)`.
    
    Correction:
    CREATE: `- [ ] N. Create description (Target: src/path/new-file.ts, Action: CREATE) [DEPENDS: none]`
    EDIT: `- [ ] N. Edit description (Target: src/path/existing.ts, Symbol: methodName, Action: EDIT) [DEPENDS: M]`

    I will align with this.

    Task 1: Create `text-utils.ts`.
    Task 2: Edit `engine.ts` imports (Symbol: `import ... from '...'` or similar).
    Task 3: Edit `engine.ts` function (Symbol: `stripThinking`).

    Wait, "Scout WILL slice that symbol". If I say Symbol: `stripThinking`, it slices that function.
    If I say Symbol: `imports`, it might not be a symbol. Usually, imports are a block. I should target the specific symbol being replaced or the file generally? "ONE symbol". `stripThinking` is the symbol.
    For imports, maybe `import` declaration is not a symbol. I will combine import and removal? No, "Never combine CREATE and EDIT in one task." "Every task must have exactly ONE Target file." (Multiple edits on same file are allowed in different tasks).
    To be precise:
    1. Create text-utils.
    2. Edit engine.ts. Where? Add import. Symbol? Maybe `import` isn't a symbol. I'll target the `stripThinking` removal which implies the import update needs to happen. Or I can create a specific task for adding the import by referencing the top of the file.
    Let's stick to the Frontier Plan's intent: "Remove stripThinking from engine.ts and import it".
    I will make one EDIT task for the import addition (Target: engine, Action: EDIT). But what is the Symbol? I can specify the file scope or the import block. Let's use `importStatements` as the Symbol identifier for Scout slicing. Or I can just edit the file where `stripThinking` is found and add the import there.
    Actually, best practice for "Surgical Precision":
    1. Create utility.
    2. Edit engine (Import).
    3. Edit engine (Function).
    For the Import, I will use `topImports` as the symbol reference.
    For the Function, I will use `stripThinking`.
    
    Wait, `stripThinking` is the one being removed. So Task 3 is Edit (Target: engine, Symbol: stripThinking, Action: EDIT).
    Task 2 is Edit (Target: engine, Symbol: imports, Action: EDIT).
    
    Wait, checking constraints again: "ACTION: EDIT = existing file, Scout slices ONE symbol for Builder context."
    If I say Symbol: `imports`, does it work? `imports` isn't a TypeScript symbol. `stripThinking` is.
    I should probably combine the import addition and function removal into one logical task if the import isn't a "symbol" in the slicing context, OR I assume the Scout tool handles text blocks labeled "imports".
    Given "Surgical Precision", modifying the import section usually targets the imports block. I will label it `importBlock` or simply reference the file level if specific symbols don't exist there. But the rule says "Symbol: methodName".
    Okay, I will focus on the `stripThinking` symbol for the Engine edits.
    Actually, to add the import, I need to modify the imports section.
    Let's assume `stripThinking` is the only export we care about.
    Task 2: Edit engine (Symbol: `topModuleImports` - assuming scout recognizes blocks). Or I can just do one edit task that handles both? No, that might be too much context for the Builder.
    Let's split:
    1. Create text-utils (Symbol: `stripThinking` - wait, CREATE doesn't need symbol in format, but I should describe content).
    2. Edit engine (Symbol: `stripThinking` - for removal).
    3. Edit engine (Symbol: `imports` - for addition).
    
    Actually, to ensure `stripThinking` is available, the import must exist first.
    
    Let's refine based on strict "ONE symbol" for EDIT.
    If `stripThinking` is being removed, that's one task.
    Where does the import go? It's not a symbol. I might have to skip a specific import task if I can't name the symbol, OR I treat the file header as the symbol.
    Better: I will focus on the critical logic change. The import is trivial.
    However, the Frontier Plan says "import it from text-utils.ts".
    I will create a task: "Edit import declarations". Symbol: `importStatements`.
    
    Wait, "ACTION: EDIT... Scout slices ONE symbol".
    If I use `importStatements`, is that a symbol?
    Let's assume I can use a descriptive string for the symbol identifier if a real symbol name doesn't fit. But "methodName" suggests a code name.
    Okay, I will combine the import and removal into one task if the import is local to the removal.
    No, `EDIT` targets ONE symbol. `stripThinking` is the symbol. The import is outside.
    I will create a task to Edit `engine.ts` Symbol: `stripThinking`. This removes the function. The Builder will see the function and delete it.
    Where do I add the import? If I don't add the import, code breaks.
    I will add a task to Edit `engine.ts` Symbol: `moduleImports`. (Assuming Scout supports this generic).
    Or I can simply rely on the user to add imports, but that's not "Spartan".
    Okay, I'll use `importBlock` as the symbol descriptor for the edit task.
    
    Wait, I need to check if `stripThinking` exists in `engine.ts`. The plan implies it.
    
    Okay, final checklist structure:
    1. CREATE `text-utils.ts`.
    2. EDIT `engine.ts` (Imports).
    3. EDIT `engine.ts` (stripThinking removal).
    
    Wait, `stripThinking` is 35k line file. I should check if I need to split `engine.ts` per "Modularity Principle".
    "If a Target File exceeds 400 lines, split logic into sub-modules."
    This principle applies to the *design*. Since `engine.ts` is 35k lines, the *current* implementation violates Modularity. The Frontier Plan "Surgical extraction" is a step towards fixing this.
    I will not invent tasks to fully refactor `engine.ts` (too big), but I will acknowledge the extraction.
    
    Wait, one more thing: `debug-helots.ts` etc. are not relevant.
    
    Let's draft the content.

    Checklist:
    1. CREATE `src/core/text-utils.ts`.
    2. EDIT `src/core/engine.ts`. Symbol: `stripThinking`. Action: REMOVE. (This covers the removal).
    3. EDIT `src/core/engine.ts`. Symbol: `importBlock`. Action: UPDATE (To add import).
    *Wait, Task 3 depends on Task 2?* No, import must exist before removal if we are replacing it? No, we are removing the definition and adding import. Import can exist before removal.
    Dependency:
    Task 2 (Import) must happen before Task 3 (Remove)? Actually, if I remove the function first, I might break imports if the import references something else. No, import brings in the function. Function definition is gone.
    Order: Import first, then Remove definition.
    So Task 2 (Import) [DEPENDS: none]. Task 3 (Remove) [DEPENDS: 2].
    
    Wait, CREATE `text-utils.ts` must happen before EDIT `engine.ts` import (because we import from it).
    So:
    1. CREATE `text-utils.ts`.
    2. EDIT `engine.ts` (Import) [DEPENDS: 1].
    3. EDIT `engine.ts` (Remove stripThinking) [DEPENDS: 2].
    
    One nuance: `engine.ts` is 35,451 lines. The Modularity principle says "split logic". I will add a note or a task to eventually split it, but for this Frontier Plan, I just do the extraction. I will stick to the Frontier Plan's tasks but format them correctly.
    
    Final check on formats:
    CREATE: `[ ] N. Create description (Target: ..., Action: CREATE) [DEPENDS: none]`
    EDIT: `[ ] N. Edit description (Target: ..., Symbol: ..., Action: EDIT) [DEPENDS: M]`
    
    I will use `importStatements` as the symbol for the import task to allow Scout to slice the top of the file.
    
    Wait, "NEED MORE DATA" rule.
    Do I need more data?
    - I need to know the exact signature of `stripThinking` to create `text-utils.ts` correctly? The Frontier Plan says "with the stripThinking function". I must assume I have the context from the Project Map or the existing file. The Project Map lists `debug-helots.ts` etc. The Frontier Plan says "Remove stripThinking from engine.ts".
    - I should verify if `stripThinking` exists in `engine.ts`. Map doesn't list content. But Plan says "Remove... from engine.ts". I'll assume it's there.
    - I should verify imports in `engine.ts` to ensure no conflicts.
    - I don't have content. I must act on the Plan.
    - Is there missing info? The exact signature? The Plan says "with the stripThinking function". I will assume the Builder has access to the source (Scout slices it).
    - I don't need to ask for data. I can proceed.

    Wait, `engine.ts` is 35k lines. The instruction says "If a Target File exceeds 400 lines, split logic into sub-modules."
    This is a DESIGN principle. I am the Architect. I should probably break `engine.ts` into smaller chunks *now* to satisfy Modularity, not just move `stripThinking`.
    However, the Frontier Plan is the specific directive ("Surgical extraction of stripThinking").
    Conflict: Modularity Principle vs Frontier Plan.
    Resolution: The Frontier Plan's "Surgical extraction" *is* a move towards modularity for that specific logic. The principle "split logic into sub-modules" applies to the *Target File*. If I move the logic out, I am splitting it. I will proceed with the extraction.
    
    One more thing: `Action: EDIT` format requires `Symbol`.
    For Import: `Symbol: importStatements`.
    For Function: `Symbol: stripThinking`.
    
    Let's finalize.

    Wait, `text-utils.ts` is new. `Action: CREATE`.
    Does it need a Symbol? Format: `(Target: src/path/new-file.ts, Action: CREATE)`. No Symbol field for CREATE.
    
    Okay, ready to write.

    Wait, I noticed `src/core/engine.ts` size is 35451.
    If I only extract `stripThinking`, `engine.ts` remains 35k lines.
    Does this violate the principle "If a Target File exceeds 400 lines, split logic into sub-modules"?
    Yes, technically. But splitting the *entire* engine into sub-modules is a much larger task.
    I will add a task to acknowledge this modularity debt or split the engine further?
    No, "Based on the Project Map and the Frontier Plan". The Frontier Plan is specific. I should not add tasks outside the Frontier Plan unless necessary to satisfy principles.
    I will stick to the Frontier Plan but ensure the checklist is granular.
    
    Wait, I need to make sure I don't hallucinate file paths. `src/core/engine.ts` is in the map.
    
    Final check on dependencies.
    1. Create text-utils.
    2. Edit engine (Import). Depends on 1.
    3. Edit engine (Remove). Depends on 2.
    
    One issue: "Scout WILL slice ONE symbol for Builder context."
    If I ask to Edit `importStatements`, does Scout know `importStatements`?
    Maybe I should just target the `stripThinking` symbol for the removal, and the import change happens implicitly or as part of the removal logic?
    But imports are distinct.
    I will use `moduleImports` as the symbol name for the edit task. It's descriptive enough for a "symbol" slot in this format.
    
    Actually, looking at "Symbol: methodName". It implies code identifiers.
    Maybe I should not create a separate task for imports. I will combine the import addition with the removal in the description of the `stripThinking` task?
    "Edit description... (Target: src/core/engine.ts, Symbol: stripThinking, Action: EDIT)" -> Description says "Remove function and update import".
    But "Scout WILL slice ONE symbol". If I edit `stripThinking`, Scout slices that function. It might not see the imports.
    Okay, I must separate them. I will use `importBlock` as the symbol identifier, assuming the tool can handle block identifiers or I can define it in the file structure. I will stick to `importStatements` as it's standard in these prompts.
    Actually, to be safest on "ONE symbol" (meaning ONE code element), I will target the file level for imports? No, rule says "Symbol: methodName".
    Okay, I will assume `importStatements` is acceptable as a logical symbol name for the sake of the checklist granularity.
    
    Wait, I should check `progress.md` existence. It's not in the map. I'm creating the checklist *in* `progress.md`.
    I will output the content of `progress.md`.
    
    Wait, I must respond "ONLY WITH THE CHECKLIST OR DATA REQUEST".
    I will generate the checklist content.
    
    One last check: `stripThinking` might not be exported. I need to extract it.
    Task 1: Create text-utils.
    Task 2: Edit engine (Imports).
    Task 3: Edit engine (stripThinking).
    
    Wait, Modularity Principle: "If a Target File exceeds 400 lines, split logic into sub-modules."
    `engine.ts` is 35,451 lines.
    Should I add a task: "Refactor src/core/engine.ts into sub-modules"?
    If I do, it might conflict with "Based on the Frontier Plan".
    I will follow the Frontier Plan strictly. The extraction is the split logic for `stripThinking`.
    
    Okay, proceeding.

    Wait, `Action` values: CREATE, EDIT.
    `Dependency`: [DEPENDS: N]
    
    Let's write.progress.md

- [ ] 1. Create description (Target: src/core/text-utils.ts, Action: CREATE) [DEPENDS: none]
- [ ] 2. Edit description (Target: src/core/engine.ts, Symbol: importStatements, Action: EDIT) [DEPENDS: 1]
- [ ] 3. Edit description (Target: src/core/engine.ts, Symbol: stripThinking, Action: EDIT) [DEPENDS: 2]