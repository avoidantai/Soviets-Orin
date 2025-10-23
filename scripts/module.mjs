// scripts/module.mjs
const { HandlebarsApplicationMixin, DocumentSheetV2 } = foundry.applications.api;

class Module {
  static ID = "rollgroups";
  static get system() { return game.system.id; }

  // --- Utility helpers ---
  static isNumeric(v) {
    return !isNaN(Number(v));
  }

  // Try to increase the dice count in a formula like "1d8+2" -> "2d8+2".
  // If the formula doesn't start with NdM, fall back to "formula + add".
  static scaleDiceFormula(formula, add) {
    if (!add || add === 0) return formula;
    // capture leading dice expression
    const m = formula.match(/^(\s*)(\d+)\s*d\s*(\d+)(.*)$/i);
    if (m) {
      const leading = m[1] || "";
      const count = Number(m[2]);
      const sides = m[3];
      const rest = m[4] || "";
      const newCount = count + add;
      return `${leading}${newCount}d${sides}${rest}`;
    }
    // fallback: append a flat bonus
    return `${formula} + ${add}`;
  }

  /** Initialize module. */
  static setup() {
    // Hook signatures: ensure the handler signatures match Foundry's API.
    Hooks.on(`${this.system}.preDisplayCard`, this.manageCardButtons);
    Hooks.on(`${this.system}.preRollDamage`, this.variantDamageLabels);
    Hooks.on("renderChatMessage", this.createChatLogListeners);
    Hooks.on("renderItemSheet", this.createConfigButton);

    // Attach the rollDamageGroup method to the item implementation
    if (Item?.implementation) {
      Item.implementation.prototype.rollDamageGroup = this.rollDamageGroup;
    } else {
      console.warn(`${this.ID} | Item.implementation not available at setup time.`);
    }
  }

  /**
   * Create the damage buttons on a chat card when an item is used. Hooks on 'preDisplayCard'.
   * @param {Item5e} item     The item being displayed.
   * @param {object} data     The data object of the message to be created.
   */
  static manageCardButtons(item, data) {
    try {
      const el = document.createElement("DIV");
      el.innerHTML = data.content;
      const damageButton = el.querySelector(".card-buttons button[data-action='damage']");
      const config = item.flags[Module.ID]?.config ?? {};

      if (damageButton) {
        const buttons = Module.createDamageButtons(item);
        if (buttons) {
          const div = document.createElement("DIV");
          div.innerHTML = buttons;
          damageButton.after(...div.children);
          damageButton.remove();
        }

        // Adjust the 'Versatile' button.
        if (buttons && Module.isNumeric(config.versatile) && item.isVersatile) {
          const vers = el.querySelector("[data-action='versatile']") ?? el.querySelector("[data-action='rollgroup-damage'][data-versatile]");
          if (vers) {
            vers.setAttribute("data-action", "rollgroup-damage-versatile");
            vers.setAttribute("data-group", String(config.versatile));
            vers.setAttribute("data-item-uuid", item.uuid);
            vers.setAttribute("data-actor-uuid", item.actor?.uuid ?? "");
          }
        }

        // Create Blade Cantrip buttons if eligible and is enabled.
        if (config.bladeCantrip && (item.type === "spell") && (item.system.level === 0) && item.hasDamage) {
          const div = document.createElement("DIV");
          div.innerHTML = `
            <hr>
            <button data-action="rollgroup-bladecantrip-attack" data-actor-uuid="${item.actor?.uuid ?? ""}">
              ${game.i18n.localize("ROLLGROUPS.BladeCantripAttack")}
            </button>
            <button data-action="rollgroup-bladecantrip-damage" data-actor-uuid="${item.actor?.uuid ?? ""}">
              ${game.i18n.localize("ROLLGROUPS.BladeCantripDamage")}
            </button>`;
          el.querySelector(".card-buttons")?.append(...div.children);
        }
      }

      // Add more saving throw buttons.
      const saveButtons = Module.createSaveButtons(item);
      if (saveButtons) {
        const save = el.querySelector("button[data-action=save]");
        if (save) {
          const div = document.createElement("DIV");
          div.innerHTML = saveButtons;
          save.after(...div.children);
        }
      }

      data.content = el.innerHTML;
    } catch (err) {
      console.error(`${this.ID} | manageCardButtons error`, err);
    }
  }

  /**
   * Helper function to construct the html for the damage buttons.
   * @param {Item5e} item       The item to retrieve data from.
   * @returns {string|null}     The constructed buttons, as a string, or null if there are no buttons to be made.
   */
  static createDamageButtons(item) {
    const config = item.flags[Module.ID]?.config ?? {};
    const validParts = (item.system?.damage?.parts ?? []).filter(([f]) => !!f);

    const hasGroups = (config.groups?.length > 0) && (validParts.length > 1);
    if (!hasGroups) return null;

    const group = config.groups.reduce((acc, { label, parts }, idx) => {
      const btn = document.createElement("BUTTON");
      btn.setAttribute("data-action", "rollgroup-damage");
      btn.setAttribute("data-group", String(idx));
      btn.setAttribute("data-item-uuid", item.uuid);
      btn.setAttribute("data-actor-uuid", item.actor?.uuid ?? "");

      const types = (parts || []).map(t => validParts[t]?.[1]);
      const systemCfg = CONFIG[Module.system.toUpperCase()] ?? {};
      const isDamage = types.every(t => t && (t in (systemCfg.damageTypes ?? {})));
      const isHealing = types.every(t => t && (t in (systemCfg.healingTypes ?? {})));

      const type = isDamage ? "damage" : isHealing ? "healing" : "mixed";
      const buttonProps = {
        damage: { i: "class='fa-solid fa-burst'", label: "Damage" },
        healing: { i: "class='dnd5e-icon' data-src='systems/dnd5e/icons/svg/damage/healing.svg'", label: "Healing" },
        mixed: { i: "class='fa-solid fa-burst'", label: "Mixed" }
      }[type];
      const labelText = label ? `(${label})` : "";
      btn.innerHTML = `<i ${buttonProps.i}></i> ${game.i18n.localize("ROLLGROUPS." + buttonProps.label)} ${labelText}`;

      acc.appendChild(btn);
      return acc;
    }, document.createElement("DIV"));

    return group.innerHTML;
  }

  /**
   * Helper function to construct the html for saving throw buttons.
   * @param {Item5e} item     The item to add buttons to.
   * @returns {string|null}
   */
  static createSaveButtons(item) {
    if (!item?.hasSave) return null;
    const system = Module.system.toUpperCase();
    const saves = (item.flags[Module.ID]?.config?.saves ?? []).filter(abi => {
      return (abi !== item.system.save?.ability) && (abi in (CONFIG[system]?.abilities ?? {}));
    });
    if (!saves.length) return null;

    const div = document.createElement("DIV");
    for (const abi of saves) {
      const btn = document.createElement("BUTTON");
      btn.setAttribute("type", "button");
      btn.setAttribute("data-action", "save");
      btn.setAttribute("data-ability", abi);
      const dc = item.getSaveDC?.() ?? item.system.save?.dc ?? 10;
      btn.setAttribute("data-dc", dc);
      const ability = CONFIG[system].abilities[abi].label;
      btn.innerHTML = `<i class="fa-solid fa-shield-heart"></i> ${game.i18n.format(`${system}.SavingThrowDC`, { dc, ability })}`;
      div.appendChild(btn);
    }
    return div.innerHTML;
  }

  /**
   * Create the button in item sheets to open the roll groups config menu.
   * Hooks on 'renderItemSheet'.
   * @param {ItemSheet5e} sheet     The sheet of an item.
   * @param {HTMLElement|jQuery|Array} html      The element of the sheet.
   */
  static createConfigButton(sheet, html) {
    try {
      // Normalize html to a real HTMLElement (support HTMLElement, jQuery, or [HTMLElement])
      const root = (function(h) {
        if (!h) return null;
        if (h instanceof HTMLElement) return h;
        if (h.jquery && h.length) return h[0];
        if (Array.isArray(h) && h.length && h[0] instanceof HTMLElement) return h[0];
        // Fallback: if it has querySelector, assume it's fine
        if (typeof h.querySelector === "function") return h;
        return null;
      })(html);

      if (!root) return;

      const addDamage = root.querySelector(".add-damage");
      if (addDamage) {
        const div = document.createElement("DIV");
        div.innerHTML = `
          <a class="${Module.ID} config-button" data-tooltip="ROLLGROUPS.OpenConfig">
            ${game.i18n.localize("ROLLGROUPS.GroupConfig")} <i class="fa-solid fa-edit"></i>
          </a>`;
        if (sheet.isEditable) {
          div.querySelector("A").addEventListener("click", () => new GroupConfig({ document: sheet.document }).render({ force: true }));
        }
        addDamage.after(div.firstElementChild);
      }

      const saveScaling = root.querySelector("[name='system.save.scaling']");
      if (saveScaling) {
        const div = document.createElement("DIV");
        div.innerHTML = `
          <a class="${Module.ID} save-config-button" data-tooltip="ROLLGROUPS.OpenSaveConfig">
            <i class="fa-solid fa-plus"></i>
          </a>`;
        if (sheet.isEditable) {
          div.querySelector("A").addEventListener("click", () => new SaveConfig({ document: sheet.document }).render({ force: true }));
        }
        saveScaling.after(div.firstElementChild);
      }
    } catch (err) {
      console.error(`${Module.ID} | createConfigButton error`, err);
    }
  }
  /**
   * Create the listener for each rollgroups button in a chat message.
   * Hooks on 'renderChatMessage'.
   * @param {ChatMessage} message     The message being rendered.
   * @param {HTMLElement} html        The element of the message.
   */
  static createChatLogListeners(message, html) {
    if (!html) return;
    html.querySelectorAll("[data-action^='rollgroup-damage']").forEach(n => {
      n.addEventListener("click", Module.rollDamageFromChat);
    });

    html.querySelectorAll("[data-action^='rollgroup-bladecantrip']").forEach(n => {
      n.addEventListener("click", Module.pickEquippedWeapon);
    });

    // Also ensure save buttons added by this module work
    html.querySelectorAll("[data-action='save'][data-dc]").forEach(n => {
      n.addEventListener("click", async ev => {
        const ability = n.dataset.ability;
        const dc = Number(n.dataset.dc);
        // send a saving throw roll for all targeted tokens (simple default behaviour)
        const speaker = ChatMessage.getSpeaker();
        const actor = fromUuidSync(n.dataset.actorUuid) ?? game.actors.get(speaker.actor);
        if (actor) {
          const roll = await actor.rollAbilityTest(ability, { chatMessage: true, fastForward: true, flavor: game.i18n.format(`${Module.system.toUpperCase()}.SavingThrowDC`, { dc, ability: CONFIG[Module.system.toUpperCase()].abilities[ability].label }) });
          return roll;
        }
      });
    });
  }

  /**
   * Make a damage roll using one of the buttons created in the chatlog.
   * @param {PointerEvent} event              The initiating click event.
   * @returns {Promise<DamageRoll|void>}      The damage roll.
   */
  static rollDamageFromChat(event) {
    const item = Module.findItem(event);
    if (!item) return;

    // The array index of the group to roll, and the parts that belong to it.
    const idx = event.currentTarget.dataset.group;
    const parts = Module.constructParts(item, Number.isFinite(Number(idx)) ? Number(idx) : idx);
    if (!parts) return;

    // A clone of the item with different damage parts.
    const clone = Module.constructClone(item, parts);

    // Additional configurations for the damage roll.
    const spellLevel = event.currentTarget.closest("[data-spell-level]")?.dataset.spellLevel;

    // Return the damage roll.
    return clone.rollDamage({
      event: event,
      spellLevel: Module.isNumeric(spellLevel) ? Number(spellLevel) : item.system.level,
      versatile: (event.currentTarget.dataset.action || "").endsWith("versatile")
    });
  }

  /**
   * Roll a damage group from an item. Added to the item class.
   */
  static async rollDamageGroup({
    rollgroup = 0,
    critical = false,
    event = null,
    spellLevel = null,
    versatile = false,
    options = {}
  } = {}) {
    const group = this.flags?.[Module.ID]?.config?.groups ?? [];
    if (!group.length) {
      return this.rollDamage?.({ critical, event, spellLevel, versatile, options });
    }

    const indices = group[rollgroup]?.parts;
    if (!indices?.length) {
      ui.notifications.error(game.i18n.localize("ROLLGROUPS.RollGroupEmpty"));
      return null;
    }

    const parts = Module.constructParts(this, rollgroup);
    if (!parts) return null;
    const clone = Module.constructClone(this, parts);

    return clone.rollDamage?.({ critical, event, spellLevel, versatile, options });
  }

  /**
   * Construct a clone of an item using a subset of its damage parts.
   */
  static constructClone(item, parts) {
    const clone = item.clone({ "system.damage.parts": parts }, { keepId: true });
    // Prepare the cloned data so rollDamage can use it
    if (typeof clone.prepareData === "function") clone.prepareData();
    return clone;
  }

  /**
   * Construct the damage parts for the clone, given an integer denoting the rollgroup.
   */
  static constructParts(item, idx) {
    const raw = item.flags?.[Module.ID]?.config?.groups?.[idx]?.parts ?? [];
    const indices = new Set((raw || []).map(n => Number(n)));
    const group = (item.system?.damage?.parts ?? []).reduce((acc, part, i) => {
      if (indices.has(i)) acc.push(part);
      return acc;
    }, []);
    if (!group.length) {
      ui.notifications.error(game.i18n.localize("ROLLGROUPS.RollGroupEmpty"));
      return false;
    }
    return group;
  }

  /**
   * Find or create an item. If the message has embedded itemData, prefer that.
   */
  static findItem(event) {
    const button = event.currentTarget;
    const messageId = button.closest("[data-message-id]")?.dataset?.messageId;
    const message = messageId ? game.messages.get(messageId) : null;
    const itemData = message?.flags?.[Module.system]?.itemData;

    // Case 1: Embedded item data in the message, construct a temporary item.
    if (itemData) {
      const actor = foundry.utils.fromUuidSync(button.dataset.actorUuid);
      if (!actor) {
        ui.notifications.error(game.i18n.localize("ROLLGROUPS.ItemOwnerMissing"));
        return null;
      }
      const item = new Item.implementation(itemData, { parent: actor });
      if (typeof item.prepareData === "function") item.prepareData();
      return item;
    }

    // Case 2: No item data, find the existing item by uuid.
    else {
      return foundry.utils.fromUuidSync(button.dataset.itemUuid);
    }
  }

  /**
   * Adjust the flavor of damage rolls depending on the damage or healing types being used.
   * Hooks on 'preRollDamage'.
   */
  static variantDamageLabels(item, config) {
    if (!item) return;
    try {
      const labels = new Set((item.getDerivedDamageLabel?.() ?? []).map(i => i.damageType));
      const isTemp = (labels.size === 1) && labels.has("temphp");
      const system = Module.system.toUpperCase();
      const string = [...labels].every(t => t in (CONFIG[system]?.healingTypes ?? {})) ? `${system}.Healing` : `${system}.DamageRoll`;
      const actionFlavor = game.i18n.localize(string);
      const title = `${item.name} - ${actionFlavor}`;

      let flavor = title;
      if (isTemp) flavor = `${title} (${game.i18n.localize(`${system}.Temp`)})`;
      else if ((item.labels?.damageTypes?.length ?? 0) > 0) flavor = `${title} (${item.labels.damageTypes})`;
      foundry.utils.mergeObject(config, { title, flavor });
    } catch (err) {
      console.error(`${Module.ID} | variantDamageLabels`, err);
    }
  }

  /**
   * Helper function to pick one of the actor's equipped melee weapons.
   */
  static async pickEquippedWeapon(event) {
    const picker = new WeaponPicker(event);
    const weps = picker.equippedWeapons;

    if (!weps.length) {
      ui.notifications.warn(game.i18n.format("ROLLGROUPS.NoEquippedWeapons", { actor: picker.actor?.name ?? "?" }));
      return null;
    }

    if (weps.length > 1) return picker.render(true);

    if ((event.currentTarget.dataset.action || "").endsWith("attack")) {
      return weps[0].rollAttack?.({ event });
    }

    if (weps[0].isVersatile || Module.createDamageButtons(weps[0])) {
      return picker.render(true);
    }

    return weps[0].rollDamage?.({ event, options: { rollConfigs: picker._scaleCantripDamage() } });
  }
}

/* -------------------------
   GroupConfig (UI dialog)
   ------------------------- */
class GroupConfig extends HandlebarsApplicationMixin(DocumentSheetV2) {
  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["rollgroups", "group-config"],
    position: { height: "auto", width: 400 },
    window: { icon: "fa-solid fa-burst", contentClasses: ["standard-form"] },
    form: { submitOnChange: true, closeOnSubmit: false },
    actions: { addGroup: this._onAddGroup, deleteGroup: this._onDeleteGroup }
  };

  static PARTS = { form: { template: `modules/${Module.ID}/templates/group-config.hbs` } };

  get title() {
    return game.i18n.format("ROLLGROUPS.GroupConfigName", { name: this.document.name });
  }

  async _prepareContext(options) {
    const context = {};
    const types = foundry.utils.mergeObject(CONFIG.DND5E.damageTypes, CONFIG.DND5E.healingTypes, { inplace: false });
    context.parts = (this.document.system?.damage?.parts ?? []).map(([formula, type], idx) => ({
      formula,
      label: types[type]?.label || game.i18n.localize("None"),
      idx
    }));

    const groupsRaw = foundry.utils.deepClone(this.document.getFlag("rollgroups", "config.groups") ?? []);
    const groups = groupsRaw.map((group, i) => {
      const partsSet = new Set((group.parts || []).map(n => Number(n)));
      return {
        label: group.label ?? "",
        idx: i,
        rows: context.parts.map(p => ({
          formula: p.formula,
          label: p.label,
          checked: partsSet.has(p.idx),
          name: `flags.rollgroups.config.groups.${i}.parts.${p.idx}`
        }))
      };
    });

    context.groups = groups;
    context.hasDamage = !!this.document.hasDamage;

    context.isVersatile = context.hasDamage && !!this.document.isVersatile;
    if (context.isVersatile) {
      const choices = groups.map(g => g.label || game.i18n.localize("ROLLGROUPS.GroupPlaceholder"));
      const value = this.document.getFlag("rollgroups", "config.versatile");
      context.versatile = {
        value: Number.isFinite(Number(value)) && value < choices.length ? Number(value) : null,
        name: "flags.rollgroups.config.versatile",
        label: "ROLLGROUPS.VersatileGroup",
        hint: "ROLLGROUPS.VersatileTooltip",
        choices
      };
    }

    context.isCantrip = context.hasDamage && (this.document.type === "spell") && (this.document.system.level === 0);
    if (context.isCantrip) {
      context.cantrip = {
        value: !!this.document.getFlag("rollgroups", "config.bladeCantrip"),
        name: "flags.rollgroups.config.bladeCantrip",
        label: "ROLLGROUPS.BladeCantrip",
        hint: "ROLLGROUPS.BladeCantripTooltip"
      };
    }

    return context;
  }

  _prepareSubmitData(event, target, formData) {
    const submitData = super._prepareSubmitData(event, target, formData);
    const path = "flags.rollgroups.config.groups";
    const raw = foundry.utils.getProperty(submitData, path) ?? {};
    const groups = Object.values(raw).map(({ label = "", parts = {} }) => {
      const p = [];
      for (const [k, v] of Object.entries(parts || {})) if (v) p.push(Number(k));
      return { label: label || game.i18n.localize("ROLLGROUPS.GroupPlaceholder"), parts: p };
    });
    foundry.utils.setProperty(submitData, path, groups);
    return submitData;
  }

  static _onAddGroup(event, target) {
    const groups = foundry.utils.deepClone(this.document.getFlag("rollgroups", "config.groups") || []);
    groups.push({ label: "", parts: [] });
    this.document.setFlag("rollgroups", "config.groups", groups);
  }

  static _onDeleteGroup(event, target) {
    const groups = foundry.utils.deepClone(this.document.getFlag("rollgroups", "config.groups") || []);
    const idx = Number(target.closest("[data-idx]")?.dataset?.idx);
    groups.splice(idx, 1);
    this.document.setFlag("rollgroups", "config.groups", groups);
  }
}

/* -------------------------
   SaveConfig (UI dialog)
   ------------------------- */
class SaveConfig extends HandlebarsApplicationMixin(DocumentSheetV2) {
  static DEFAULT_OPTIONS = {
    tag: "form",
    position: { height: "auto", width: 400 },
    window: { icon: "fa-solid fa-person-falling-burst", contentClasses: ["standard-form"] },
    form: { submitOnChange: false, closeOnSubmit: true }
  };

  static PARTS = {
    form: { template: `modules/${Module.ID}/templates/save-config.hbs` },
    footer: { template: `modules/${Module.ID}/templates/footer.hbs` }
  };

  get title() {
    return game.i18n.format("ROLLGROUPS.SaveConfigName", { name: this.document.name });
  }

  async _prepareContext(options) {
    const configSet = new Set(this.document.flags[Module.ID]?.config?.saves ?? []);
    const abilities = Object.entries(CONFIG[Module.system.toUpperCase()].abilities).map(([key, data]) => ({
      value: configSet.has(key),
      name: `flags.rollgroups.config.saves.${key}`,
      label: data.label,
      disabled: key === this.document.system.save?.ability,
      rootId: this.document.id
    }));
    return { abilities };
  }

  _prepareSubmitData(event, form, formData) {
    const submitData = super._prepareSubmitData(event, form, formData);
    const path = "flags.rollgroups.config.saves";
    const pick = Object.entries(foundry.utils.getProperty(submitData, path) || {}).reduce((acc, [k, v]) => {
      if (v) acc.push(k);
      return acc;
    }, []);
    foundry.utils.setProperty(submitData, path, pick);
    return submitData;
  }
}

/* -------------------------
   WeaponPicker dialog
   ------------------------- */
class WeaponPicker extends dnd5e.applications.DialogMixin(Application) {
  constructor(event) {
    super();
    const target = event.currentTarget;
    this.actor = foundry.utils.fromUuidSync(target.dataset.actorUuid) ?? game.actors.get(target.dataset.actorId);
    const isNPC = this.actor?.type === "npc";
    this.cantrip = this.actor?.items.get(target.closest("[data-item-id]")?.dataset?.itemId);
    this.equippedWeapons = (this.actor?.items ?? new Collection()).filter(item =>
      item.type === "weapon" && (isNPC || item.system?.equipped) && item.hasAttack && item.hasDamage
    );
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      template: `modules/${Module.ID}/templates/weapon_picker.hbs`,
      classes: [Module.ID, "weapon-picker", "dnd5e2", "dialog"],
      height: "auto",
      width: "auto"
    });
  }

  get title() {
    return game.i18n.format("ROLLGROUPS.PickWeapon", { name: this.cantrip?.name || "Weapon" });
  }

  async getData() {
    return { weapons: this.equippedWeapons.map(w => ({ weapon: w, context: Module.createDamageButtons(w) })) };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.querySelectorAll("[data-action='attack']").forEach(n => n.addEventListener("click", this._onClickAttack.bind(this)));
    html.querySelectorAll("[data-action='rollgroup-damage']").forEach(n => n.addEventListener("click", this._onClickDamage.bind(this)));
    html.querySelector(".weapons")?.addEventListener("wheel", this._onScrollWeapons.bind(this));
    html.querySelectorAll("[data-action='roll']").forEach(n => n.addEventListener("click", this._onQuickRoll.bind(this)));
    html.querySelectorAll("button").forEach(n => n.classList.add("gold-button"));
  }

  async _onQuickRoll(event) {
    const weapon = this.actor.items.get(event.currentTarget.closest("[data-item-id]")?.dataset?.itemId);
    const attack = await weapon?.rollAttack?.({ event });
    if (!attack) return null;
    this.close();
    return weapon?.rollDamageGroup?.({ options: { rollConfigs: this._scaleCantripDamage() } });
  }

  _onScrollWeapons(event) {
    event.preventDefault();
    event.currentTarget.scrollLeft += 1.5 * event.deltaY;
  }

  async _onClickAttack(event) {
    return this.actor.items.get(event.currentTarget.closest("[data-item-id]")?.dataset?.itemId)?.rollAttack?.({ event });
  }

  async _onClickDamage(event) {
    const weapon = this.actor.items.get(event.currentTarget.closest("[data-item-id]")?.dataset?.itemId);
    this.close();

    const parts = this._scaleCantripDamage();
    const versatile = event.currentTarget.dataset.versatile !== undefined;
    const group = event.currentTarget.dataset.group !== undefined;

    const config = { event, options: { rollConfigs: parts }, versatile };
    if (versatile) config.rollgroup = Number(weapon.flags?.[Module.ID]?.config?.versatile ?? 0);
    else if (group) config.rollgroup = Number(event.currentTarget.dataset.group);

    return weapon?.rollDamageGroup?.(config);
  }

  _scaleCantripDamage() {
    // Default safe fallback
    if (!this.cantrip?.system?.damage?.parts?.length) return { parts: [], type: null };

    const part = this.cantrip.system.damage.parts[0];
    const level = Number(this.actor?.system?.details?.level ?? this.actor?.system?.details?.spellLevel ?? 1);
    const add = Math.floor((level + 1) / 6); // replicate previous behavior
    const formula = Module.scaleDiceFormula(part[0], add);
    return { parts: [formula], type: part[1] };
  }
}

/* -------------------------
   Setup
   ------------------------- */
Hooks.once("setup", () => Module.setup());
