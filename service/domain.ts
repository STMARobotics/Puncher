import { type Store, Tx, atomic, all, Conflict } from "./store";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { assignCard } from "./card-codes";
import {
  type Row,
  type Principal,
  key,
  row,
  uid,
  hash,
  Fault,
  assert,
  admin,
  mentor,
  owns,
  text,
  barcode,
  localDay,
  cutoff,
  reportingYear,
  validDate,
  hoursToSeconds,
  eligible,
} from "./model";
const shopClockKey = (day: string) => key("SHOP_CLOCK#" + day);

function staffedMillis(shop: Row | undefined, now: number) {
  return (
    (shop?.staffedMillis ?? 0) +
    (shop?.openedAt === undefined ? 0 : Math.max(0, now - shop.openedAt))
  );
}

export class Puncher {
  constructor(
    readonly store: Store,
    readonly clock: () => Date = () => new Date(),
    readonly cooldown = 5,
  ) {}
  audit(
    tx: Tx,
    p: Principal,
    action: string,
    target: string,
    details: Record<string, unknown> = {},
  ) {
    const at = this.clock().toISOString();
    return tx.put(
      row("AUDIT", `${at}#${uid()}`, {
        action,
        target,
        actor: p.id,
        at,
        ...details,
      }),
    );
  }
  async livePrincipal(tx: Tx, p: Principal) {
    const r = await tx.get(
      key(`${p.kind === "device" ? "DEVICE" : "IDENTITY"}#${p.id}`),
    );
    assert(
      r &&
        (p.kind === "device"
          ? r.enabled && r.expiresAt > this.clock().toISOString()
          : r.enabled),
      "Access disabled. Ask an administrator for setup.",
      403,
    );
    if (p.kind === "human") {
      assert(
        JSON.stringify(r.roles) === JSON.stringify(p.roles),
        "Permissions changed. Sign in again.",
        403,
      );
      if (r.memberId) {
        const member = await tx.get(key(`MEMBER#${r.memberId}`));
        assert(member?.active, "Member account is inactive.", 403);
      }
    } else {
      assert(
        r.sessionType === "mentor-launch" && r.launchedBy,
        "A mentor must launch this kiosk.",
        403,
      );
      const owner = await tx.get(key("IDENTITY#" + r.launchedBy));
      assert(
        owner?.enabled &&
          owner.roles?.some((role: string) =>
            ["mentor", "admin"].includes(role),
          ),
        "The mentor who launched this kiosk no longer has access.",
        403,
      );
      if (owner.memberId)
        assert(
          (await tx.get(key("MEMBER#" + owner.memberId)))?.active,
          "The mentor account is inactive.",
          403,
        );
    }
    return r;
  }
  async rate(tx: Tx, p: Principal) {
    const minute = this.clock().toISOString().slice(0, 16);
    const k = key(`RATE#${p.kind}#${p.id}`, minute);
    const r = await tx.get(k);
    assert((r?.count || 0) < 120, "Too many requests. Wait a moment.", 429);
    await tx.put(
      row(k.pk, k.sk, {
        count: (r?.count || 0) + 1,
        ttl: Math.floor(this.clock().getTime() / 1000) + 120,
      }),
    );
  }
  async cardMember(tx: Tx, card: string) {
    const claim = await tx.get(key("CARD#" + barcode(card)));
    assert(claim, "Card is not assigned. Ask a mentor.", 404);
    return tx.get(key("MEMBER#" + claim.memberId));
  }
  async memberForCard(tx: Tx, card: string) {
    const m = await this.cardMember(tx, card);
    assert(
      m?.active && m.memberKind === "student",
      "This card is inactive or unavailable.",
      403,
    );
    return m;
  }
  async expire(tx: Tx, current: Row, now: string): Promise<Row> {
    if (!current.sessionId || current.cutoffAt > now) return current;
    const session = await tx.get(key(current.pk, current.sessionSk));
    if (session?.status === "active") {
      await tx.put({
        ...session,
        status: "forfeited_missing_checkout",
        creditedSeconds: 0,
        forfeitedAt: now,
        reason: "missing_checkout",
      });
      await tx.del(
        key(
          "ACTIVE",
          `${current.cutoffAt}#${current.memberId}#${current.sessionId}`,
        ),
      );
      await this.audit(
        tx,
        { id: "midnight-policy", kind: "device", roles: [] },
        "shop.forfeit",
        session.sessionId,
        { memberId: current.memberId, shopDate: session.shopDate },
      );
    }
    const next = {
      ...current,
      sessionId: null,
      sessionSk: null,
      warning: {
        id: uid(),
        shopDate: current.shopDate,
        sessionId: current.sessionId,
      },
    };
    await tx.put(next);
    return next;
  }
  async readShopClock(tx: Tx) {
    const day = localDay(this.clock());
    const shop = await tx.get(shopClockKey(day));
    const observed = this.clock();
    if (localDay(observed) !== day) throw new Conflict();
    const timestamp = Math.max(observed.getTime(), shop?.updatedAtMillis ?? 0);
    return { day, shop, timestamp, now: new Date(timestamp).toISOString() };
  }
  // Attendance transactions condition on this clock so a scan cannot race
  // a change in mentor coverage on another kiosk.
  async changeMentorCount(
    tx: Tx,
    day: string,
    shop: Row | undefined,
    now: number,
    delta: 1 | -1,
  ) {
    const mentorCount = (shop?.mentorCount ?? 0) + delta;
    assert(
      mentorCount >= 0,
      "Shop attendance state needs administrator attention.",
      409,
    );
    await tx.put(
      row(shopClockKey(day).pk, "METADATA", {
        mentorCount,
        staffedMillis:
          mentorCount === 0
            ? staffedMillis(shop, now)
            : (shop?.staffedMillis ?? 0),
        openedAt: mentorCount === 0 ? undefined : (shop?.openedAt ?? now),
        updatedAtMillis: now,
        ttl: Math.floor(Date.parse(cutoff(day)) / 1000) + 7 * 86400,
      }),
    );
  }
  async startVisit(
    tx: Tx,
    current: Row,
    day: string,
    now: string,
    isMentor: boolean,
    openMillis: number,
  ) {
    const sessionId = uid();
    const sk = ["SHOP", now, sessionId].join("#");
    const c = cutoff(day);
    await tx.put(
      row(current.pk, sk, {
        sessionId,
        memberId: current.memberId,
        shopDate: day,
        reportingYear: reportingYear(day),
        startedAt: now,
        cutoffAt: c,
        status: "active",
        creditedSeconds: 0,
        isMentor,
        staffedMillisAtStart: openMillis,
      }),
    );
    await tx.put(
      row("ACTIVE", [c, current.memberId, sessionId].join("#"), {
        memberId: current.memberId,
        sessionId,
        cutoffAt: c,
      }),
    );
    return { ...current, sessionId, sessionSk: sk, cutoffAt: c, shopDate: day };
  }
  async currentVisit(tx: Tx, memberId: string, now: string) {
    const k = key("MEMBER#" + memberId, "CURRENT");
    const before =
      (await tx.get(k)) ?? row(k.pk, k.sk, { memberId, sessionId: null });
    return {
      current: await this.expire(tx, before, now),
      stale: !!before.sessionId && before.cutoffAt <= now,
    };
  }
  async scan(p: Principal, cardInput: unknown, operationId: string) {
    assert(p.kind === "device", "Kiosk device authorization required.", 403);
    const card = barcode(cardInput);
    assert(
      /^[0-9a-f-]{36}$/.test(operationId),
      "A UUID operation ID is required.",
    );
    const payload = hash(JSON.stringify({ card }));
    return atomic(this.store, async (tx) => {
      await this.livePrincipal(tx, p);
      const opKey = key(`OP#${p.id}`, `SHOP#${operationId}`);
      const old = await tx.get(opKey);
      if (old) {
        assert(
          old.payload === payload,
          "Operation ID was used for a different payload.",
          409,
        );
        assert(
          old.responseUntil > this.clock().toISOString(),
          "Operation replay window expired. Ask an adult to inspect the saved operation; do not rescan.",
          409,
        );
        return old.result;
      }
      await this.rate(tx, p);
      const m = await this.cardMember(tx, card);
      assert(m, "This card is inactive or unavailable.", 403);
      const { day, shop, timestamp, now } = await this.readShopClock(tx);
      const { current, stale } = await this.currentVisit(tx, m.memberId, now);
      let cur = current;
      assert(
        m.active || cur.sessionId,
        "This card is inactive or unavailable.",
        403,
      );
      assert(
        cur.sessionId || shop?.mentorCount > 0,
        "Shop closed. Ask a mentor to reopen it with an activation QR.",
        403,
      );
      const openMillis = staffedMillis(shop, timestamp);
      if (
        !stale &&
        cur.shopDate === day &&
        cur.lastScanAt &&
        timestamp - Date.parse(cur.lastScanAt) < this.cooldown * 1000
      ) {
        const result = {
          ...cur.lastResult,
          state: "cooldown",
          message:
            "Scan already received. Please wait before scanning this card again.",
          warning: cur.warning,
        };
        await tx.put(
          row(opKey.pk, opKey.sk, {
            memberId: m.memberId,
            payload,
            result,
            responseUntil: new Date(
              this.clock().getTime() + 86400000,
            ).toISOString(),
          }),
        );
        return result;
      }
      let result: any;
      if (cur.sessionId) {
        const session = await tx.get(key(cur.pk, cur.sessionSk));
        assert(
          session?.status === "active",
          "Attendance state needs administrator attention.",
          409,
        );
        // Legacy visits have no baseline. Only tracked staffed time is
        // credited and never more than the time since the visit began.
        const seconds = Math.floor(
          Math.max(
            0,
            Math.min(
              Date.parse(now) - Date.parse(session.startedAt),
              openMillis - (session.staffedMillisAtStart ?? 0),
            ),
          ) / 1000,
        );
        if (session.isMentor)
          await this.changeMentorCount(tx, day, shop, timestamp, -1);
        await tx.put({
          ...session,
          status: "completed",
          endedAt: now,
          creditedSeconds: seconds,
        });
        await tx.del(
          key(
            "ACTIVE",
            `${session.cutoffAt}#${m.memberId}#${session.sessionId}`,
          ),
        );
        const previous = (await all(this.store, cur.pk, { prefix: `SHOP#` }))
          .filter((r) => r.shopDate === day && eligible(r))
          .reduce((n, r) => n + r.creditedSeconds, 0);
        result = {
          state: "out",
          displayName: m.displayName,
          startedAt: session.startedAt,
          endedAt: now,
          creditedSeconds: seconds,
          todaySeconds: previous + seconds,
          warning: cur.warning,
        };
        cur = { ...cur, sessionId: null, sessionSk: null };
      } else {
        const isMentor = m.memberKind === "mentor";
        cur = await this.startVisit(tx, cur, day, now, isMentor, openMillis);
        if (isMentor) await this.changeMentorCount(tx, day, shop, timestamp, 1);
        result = {
          state: "in",
          displayName: m.displayName,
          startedAt: now,
          warning: cur.warning,
        };
      }
      await tx.put({ ...cur, lastScanAt: now, lastResult: result });
      await tx.put(
        row(opKey.pk, opKey.sk, {
          memberId: m.memberId,
          payload,
          result,
          responseUntil: new Date(
            this.clock().getTime() + 86400000,
          ).toISOString(),
        }),
      );
      await this.audit(tx, p, `shop.${result.state}`, m.memberId, {
        operationId,
      });
      return result;
    });
  }
  async operation(p: Principal, id: string) {
    assert(p.kind === "device", "Device required.", 403);
    const r = await this.store.get(key(`OP#${p.id}`, `SHOP#${id}`));
    assert(r, "Operation not found.", 404);
    assert(
      r.responseUntil > this.clock().toISOString(),
      "Operation response expired. Ask an adult.",
      409,
    );
    return r.result;
  }
  async acknowledge(p: Principal, id: string, warningId: string) {
    assert(p.kind === "device", "Device required.", 403);
    return atomic(this.store, async (tx) => {
      await this.livePrincipal(tx, p);
      const op = await tx.get(key(`OP#${p.id}`, `SHOP#${id}`));
      assert(
        op?.result.warning?.id === warningId,
        "Warning does not belong to this operation.",
        404,
      );
      assert(op.memberId, "Delivery target not found.", 409);
      const c = await tx.get(key(`MEMBER#${op.memberId}`, "CURRENT"));
      if (c?.warning?.id === warningId) await tx.put({ ...c, warning: null });
      await this.audit(tx, p, "warning.delivered", op.memberId, {
        operationId: id,
        warningId,
      });
      return { delivered: true };
    });
  }
  async cleanup() {
    let cursor;
    let expired = 0;
    do {
      const page = await this.store.query("ACTIVE", { cursor });
      for (const r of page.items) {
        if (r.cutoffAt > this.clock().toISOString()) continue;
        await atomic(this.store, async (tx) => {
          const c = await tx.get(key(`MEMBER#${r.memberId}`, "CURRENT"));
          if (
            c &&
            c.sessionId === r.sessionId &&
            c.cutoffAt <= this.clock().toISOString()
          ) {
            await this.expire(tx, c, this.clock().toISOString());
            expired++;
          } else await tx.del(key(r.pk, r.sk));
        });
      }
      cursor = page.cursor;
    } while (cursor);
    return { expired };
  }
  async saveMember(p: Principal, input: any, id = uid()) {
    mentor(p);
    const displayName = text(input.displayName, "Name", 100);
    assert(
      ["student", "mentor"].includes(input.memberKind),
      "Invalid member kind.",
    );
    assert(typeof input.active === "boolean", "Active is required.");
    const requestedCard =
      input.barcode === "" || input.barcode == null
        ? undefined
        : barcode(input.barcode);
    return atomic(this.store, async (tx) => {
      await this.livePrincipal(tx, p);
      const k = key(`MEMBER#${id}`);
      const previous = await tx.get(k);
      assert(
        !previous?.csvEmail ||
          input.email === undefined ||
          (typeof input.email === "string" &&
            input.email.trim().toLowerCase() === previous.csvEmail),
        "For a CSV member email change, upload the new address and select the existing member to preserve their history.",
        409,
      );
      const card = await assignCard(tx, id, requestedCard ?? previous?.barcode);
      if (card !== previous?.barcode) {
        if (previous?.barcode) {
          await assignCard(tx, id, previous.barcode);
          await tx.del(key(`CARD#${previous.barcode}`));
        }
        if (card) {
          const claim = await tx.get(key(`CARD#${card}`));
          assert(
            !claim || claim.memberId === id,
            "Card is already assigned.",
            409,
          );
          await tx.put(row(`CARD#${card}`, "METADATA", { memberId: id }));
        }
      }
      const m = row(k.pk, k.sk, {
        memberId: id,
        displayName,
        memberKind: input.memberKind,
        active: input.active,
        manuallyDisabled:
          previous && previous.active === input.active
            ? !!previous.manuallyDisabled
            : !input.active,
        email: previous?.csvEmail
          ? previous.email
          : typeof input.email === "string"
            ? input.email.trim().slice(0, 254)
            : previous?.email,
        barcode: card,
        gsi1pk: "MEMBERS",
        gsi1sk: id,
      });
      await tx.put({ ...previous, ...m });
      await this.audit(tx, p, "member.saved", id, {
        cardChanged: card !== previous?.barcode,
        active: input.active,
      });
      return { memberId: id, barcode: card };
    });
  }
  async replaceCard(p: Principal, id: string, operationId: string) {
    mentor(p);
    assert(
      typeof operationId === "string" && /^[a-f0-9-]{36}$/i.test(operationId),
      "A replacement operation ID is required.",
    );
    return atomic(this.store, async (tx) => {
      await this.livePrincipal(tx, p);
      const opKey = key("OP#" + p.id, "CARD#" + operationId);
      const existing = await tx.get(opKey);
      if (existing) {
        assert(
          existing.memberId === id,
          "Operation belongs to another member.",
          409,
        );
        return existing.result;
      }
      const member = await tx.get(key("MEMBER#" + id));
      assert(member, "Member not found.", 404);
      if (member.barcode) {
        await assignCard(tx, id, member.barcode);
        await tx.del(key("CARD#" + member.barcode));
      }
      const card = await assignCard(tx, id);
      await tx.put({ ...member, barcode: card });
      await tx.put(
        row(opKey.pk, opKey.sk, { memberId: id, result: { barcode: card } }),
      );
      await this.audit(tx, p, "member.card_replaced", id);
      return { barcode: card };
    });
  }
  async saveIdentity(p: Principal, input: any) {
    admin(p);
    const sub = text(input.googleSub, "Verified Google subject");
    const email = text(input.email, "Email").toLowerCase();
    assert(
      /^[^@]+@stmarobotics\.org$/.test(email),
      "Use a stmarobotics.org email.",
    );
    assert(
      Array.isArray(input.roles) &&
        input.roles.every((r: any) =>
          [
            "student",
            "mentor",
            "admin",
            "stats:student",
            "stats:staff",
          ].includes(r),
        ),
      "Invalid permissions.",
    );
    assert(typeof input.enabled === "boolean", "Enabled flag required.");
    assert(
      sub !== p.id || (input.enabled && input.roles.includes("admin")),
      "You cannot remove your own administrator access.",
      403,
    );
    return atomic(this.store, async (tx) => {
      await this.livePrincipal(tx, p);
      const k = key(`IDENTITY#${sub}`);
      const before = await tx.get(k);
      if (input.memberId) {
        const member = await tx.get(key(`MEMBER#${input.memberId}`));
        assert(member, "Member not found.");
        assert(
          !member.directoryUserId || member.directoryUserId === sub,
          "Member is linked to a different Google Directory account.",
          409,
        );
        const claim = await tx.get(key(`BINDING#${input.memberId}`));
        assert(
          !claim || claim.googleSub === sub,
          "Member is already linked to another identity.",
          409,
        );
        await tx.put(
          row(`BINDING#${input.memberId}`, "METADATA", { googleSub: sub }),
        );
      }
      if (before?.memberId && before.memberId !== input.memberId)
        await tx.del(key(`BINDING#${before.memberId}`));
      await tx.put(
        row(k.pk, k.sk, {
          googleSub: sub,
          memberId: input.memberId || undefined,
          displayName: before?.displayName,
          email,
          enabled: input.enabled,
          roles: input.roles,
          gsi1pk: "IDENTITIES",
          gsi1sk: sub,
        }),
      );
      await this.audit(tx, p, "identity.saved", sub);
      return { saved: true };
    });
  }
  async createDevice(p: Principal, label: string) {
    admin(p);
    return this.launchKiosk(p, undefined, label);
  }
  async approveMentor(
    p: Principal,
    sub: string,
    administrator: boolean,
    statsReports: boolean,
  ) {
    admin(p);
    return atomic(this.store, async (tx) => {
      await this.livePrincipal(tx, p);
      const requestKey = key("MENTOR_REQUEST#" + sub),
        request = await tx.get(requestKey);
      assert(
        request && request.ttl > this.clock().getTime() / 1000,
        "Mentor request expired or not found. Ask them to sign in again.",
        404,
      );
      const k = key("IDENTITY#" + sub),
        before = await tx.get(k);
      // Preserve Stats roles and the existing member binding when adding Puncher access.
      const roles = [
        ...new Set([
          ...(before?.roles ?? []),
          "mentor",
          ...(administrator ? ["admin"] : []),
          ...(statsReports ? ["stats:staff"] : []),
        ]),
      ];
      await tx.put({
        ...before,
        ...row(k.pk, k.sk, {
          googleSub: sub,
          memberId: before?.memberId,
          email: request.email,
          displayName: request.displayName ?? before?.displayName,
          enabled: true,
          roles,
          gsi1pk: "IDENTITIES",
          gsi1sk: sub,
        }),
      });
      await tx.del(requestKey);
      await this.audit(tx, p, "mentor.approved", sub, {
        administrator,
        statsReports,
      });
      return { approved: true };
    });
  }
  async mentorAttendanceMember(tx: Tx, p: Principal, identity: Row) {
    let memberId = identity.memberId as string | undefined;
    if (!memberId) {
      const directory = await tx.get(key("DIRECTORY#" + p.id));
      const email = identity.email?.trim().toLowerCase();
      const roster =
        email && (await tx.get(key("ROSTER_EMAIL#" + hash(email))));
      memberId =
        directory?.memberId ??
        (roster && !roster.retired ? roster.memberId : undefined);
    }
    memberId ??= uid();
    const memberKey = key("MEMBER#" + memberId);
    const member = await tx.get(memberKey);
    const bindingKey = key("BINDING#" + memberId);
    const binding = await tx.get(bindingKey);
    const login = await tx.get(key("ROSTER_LOGIN#" + memberId));
    assert(
      (!binding || binding.googleSub === p.id) &&
        (!login || login.sub === p.id) &&
        (!member?.directoryUserId || member.directoryUserId === p.id),
      "This attendance member is linked to another account. Ask an administrator to review it.",
      409,
    );
    assert(
      !member || member.active,
      "The mentor attendance account is inactive.",
      403,
    );
    const card = await assignCard(tx, memberId, member?.barcode);
    const profileName = identity.displayName as string | undefined;
    const accountName = identity.email?.split("@")[0].replace(/[._-]+/g, " ");
    const displayName =
      member?.displayName ??
      (profileName && !profileName.includes("@")
        ? profileName
        : accountName || "Mentor");
    if (!member || member.memberKind !== "mentor" || member.barcode !== card)
      await tx.put({
        ...member,
        ...row(memberKey.pk, memberKey.sk, {
          memberId,
          displayName,
          memberKind: "mentor",
          active: true,
          barcode: card,
          gsi1pk: "MEMBERS",
          gsi1sk: memberId,
        }),
      });
    if (!binding)
      await tx.put(row(bindingKey.pk, bindingKey.sk, { googleSub: p.id }));
    if (identity.memberId !== memberId) {
      await tx.put({ ...identity, memberId });
      await this.audit(tx, p, "member.mentor_linked", memberId);
    }
    return { memberId, barcode: card, displayName };
  }
  async clockInLaunchingMentor(tx: Tx, p: Principal, identity: Row) {
    const { memberId, displayName } = await this.mentorAttendanceMember(
      tx,
      p,
      identity,
    );
    const { day, shop, timestamp, now } = await this.readShopClock(tx);
    const { current } = await this.currentVisit(tx, memberId, now);
    const active = current.sessionId
      ? await tx.get(key(current.pk, current.sessionSk))
      : undefined;
    assert(
      !current.sessionId || active?.status === "active",
      "Attendance state needs administrator attention.",
      409,
    );
    if (active?.isMentor) return now;
    await this.changeMentorCount(tx, day, shop, timestamp, 1);
    if (active) {
      // An already active visit keeps the original start and earned time.
      await tx.put({ ...active, isMentor: true });
    } else {
      const visit = await this.startVisit(
        tx,
        current,
        day,
        now,
        true,
        staffedMillis(shop, timestamp),
      );
      await tx.put({
        ...visit,
        lastScanAt: null,
        lastResult: {
          state: "in",
          displayName,
          startedAt: now,
          warning: current.warning,
        },
      });
      await this.audit(tx, p, "shop.in", memberId, {
        source: "kiosk_activation",
      });
    }
    return now;
  }
  async issueKioskActivation(p: Principal) {
    mentor(p);
    const code = "PUNCHER-" + randomBytes(24).toString("hex").toUpperCase();
    const expires = new Date(this.clock().getTime() + 2 * 60_000);
    return atomic(this.store, async (tx) => {
      const identity = await this.livePrincipal(tx, p);
      const { barcode } = await this.mentorAttendanceMember(tx, p, identity);
      await tx.put(
        row("KIOSK_ACTIVATION#" + hash(code), "METADATA", {
          mentorId: p.id,
          expiresAt: expires.toISOString(),
          ttl: Math.floor(expires.getTime() / 1000),
        }),
      );
      return { code, expiresAt: expires.toISOString(), barcode };
    });
  }
  async activateKiosk(
    code: unknown,
    presented?: string,
    browserSession?: string,
  ) {
    assert(
      typeof code === "string" && /^PUNCHER-[0-9A-F]{48}$/.test(code),
      "Scan a valid Puncher activation code.",
    );
    const activationKey = key("KIOSK_ACTIVATION#" + hash(code));
    const activation = await this.store.get(activationKey);
    assert(
      activation && activation.expiresAt > this.clock().toISOString(),
      "This code expired or was already used. Ask a mentor for a new one.",
      401,
    );
    const identity = await this.store.get(
      key("IDENTITY#" + activation.mentorId),
    );
    return this.launchKiosk(
      { kind: "human", id: activation.mentorId, roles: identity?.roles ?? [] },
      presented,
      "Shop kiosk",
      browserSession,
      activationKey,
    );
  }
  async launchKiosk(
    p: Principal,
    presented?: string,
    label = "Shop kiosk",
    mentorSessionToken?: string,
    activationKey?: ReturnType<typeof key>,
  ) {
    mentor(p);
    const [oldId, oldSecret] = (presented ?? "").split(".");
    const generatedId = uid(),
      secret = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      this.clock().getTime() + 12 * 3600000,
    ).toISOString();
    const session = await atomic(this.store, async (tx) => {
      const identity = await this.livePrincipal(tx, p);
      if (activationKey) {
        const activation = await tx.get(activationKey);
        assert(
          activation?.mentorId === p.id &&
            activation.expiresAt > this.clock().toISOString(),
          "This code expired or was already used. Ask a mentor for a new one.",
          401,
        );
        await tx.del(activationKey);
      }
      // Hand over this browser to a kiosk without leaving its seven-day mentor
      // session usable. Revoke it in the same transaction as session creation.
      if (mentorSessionToken) {
        const humanKey = key("SESSION#" + hash(mentorSessionToken));
        if (await tx.get(humanKey)) await tx.del(humanKey);
      }
      const previous =
        oldId && oldSecret && oldId.length <= 100 && oldSecret.length <= 200
          ? await tx.get(key("DEVICE#" + oldId))
          : undefined;
      const expected = Buffer.from(previous?.secretHash ?? ""),
        actual = Buffer.from(hash(oldSecret ?? ""));
      const resumed =
        !!previous &&
        expected.length === actual.length &&
        timingSafeEqual(expected, actual);
      const id = resumed ? oldId : generatedId;
      const now = await this.clockInLaunchingMentor(tx, p, identity);
      await tx.put(
        row(`DEVICE#${id}`, "METADATA", {
          deviceId: id,
          label: text(label, "Device name", 80),
          secretHash: hash(secret),
          enabled: true,
          sessionType: "mentor-launch",
          launchedBy: p.id,
          launchedAt: now,
          ttl: Math.floor(this.clock().getTime() / 1000) + 31 * 86400,
          expiresAt,
          gsi1pk: "DEVICES",
          gsi1sk: id,
        }),
      );
      await this.audit(tx, p, "kiosk.launched", id, { resumed });
      return { sessionId: id, resumed };
    });
    return {
      credential: `${session.sessionId}.${secret}`,
      expiresAt,
      ...session,
    };
  }
  async revokeDevice(p: Principal, id: string) {
    mentor(p);
    return atomic(this.store, async (tx) => {
      await this.livePrincipal(tx, p);
      const d = await tx.get(key(`DEVICE#${id}`));
      assert(d, "Device not found.", 404);
      assert(
        p.roles.includes("admin") || d.launchedBy === p.id,
        "This kiosk belongs to a different mentor.",
        403,
      );
      await tx.put({ ...d, enabled: false });
      await this.audit(tx, p, "device.revoked", id);
      return { revoked: true };
    });
  }
  async saveEvent(p: Principal, input: any, id = uid()) {
    mentor(p);
    const durationSeconds = hoursToSeconds(input.hours);
    assert(
      durationSeconds > 0 && durationSeconds <= 86400,
      "Event credit must be positive and at most 24 hours.",
    );
    const eventDate = validDate(input.eventDate);
    return atomic(this.store, async (tx) => {
      await this.livePrincipal(tx, p);
      const k = key(`EVENT#${id}`);
      const old = await tx.get(k);
      if (old) {
        owns(p, old);
        assert(
          !old.participantCount ||
            (old.durationSeconds === durationSeconds &&
              old.eventDate === eventDate &&
              old.title === input.title),
          "Title, date and hours are locked after attendance exists.",
          409,
        );
      }
      const e = row(k.pk, k.sk, {
        eventId: id,
        title: text(input.title, "Event title", 120),
        eventDate,
        reportingYear: reportingYear(eventDate),
        durationSeconds,
        notes:
          typeof input.notes === "string" ? input.notes.slice(0, 2000) : "",
        mentorSub: old?.mentorSub || p.id,
        version: (old?.version || 0) + 1,
        participantCount: old?.participantCount || 0,
        gsi1pk: "EVENTS",
        gsi1sk: `${eventDate}#${id}`,
      });
      await tx.put(e);
      await this.audit(tx, p, "event.saved", id);
      return e;
    });
  }
  async award(p: Principal, eventId: string, card: unknown) {
    mentor(p);
    return atomic(this.store, async (tx) => {
      await this.livePrincipal(tx, p);
      await this.rate(tx, p);
      const e = await tx.get(key(`EVENT#${eventId}`));
      assert(e, "Event not found.", 404);
      owns(p, e);
      const m = await this.memberForCard(tx, barcode(card));
      const claimKey = key(e.pk, `PARTICIPANT#${m.memberId}`);
      const claim = await tx.get(claimKey);
      if (claim)
        return {
          state: "already",
          displayName: m.displayName,
          creditedSeconds: claim.creditedSeconds,
        };
      const awardId = uid(),
        recordedAt = this.clock().toISOString(),
        creditSk = `VOLUNTEER#${e.eventDate}#${awardId}`;
      const c = row(`MEMBER#${m.memberId}`, creditSk, {
        awardId,
        memberId: m.memberId,
        eventId,
        title: e.title,
        eventDate: e.eventDate,
        reportingYear: e.reportingYear,
        creditedSeconds: e.durationSeconds,
        status: "approved",
        recordedBy: p.id,
        recordedAt,
        eventVersion: e.version,
      });
      await tx.put(c);
      await tx.put(
        row(e.pk, claimKey.sk, {
          memberId: m.memberId,
          displayName: m.displayName,
          creditedSeconds: e.durationSeconds,
          creditSk,
          awardId,
          recordedAt,
        }),
      );
      await tx.put({ ...e, participantCount: e.participantCount + 1 });
      await this.audit(tx, p, "volunteer.awarded", awardId, {
        eventId,
        memberId: m.memberId,
      });
      return {
        state: "logged",
        displayName: m.displayName,
        creditedSeconds: e.durationSeconds,
      };
    });
  }
  async removeAward(
    p: Principal,
    eventId: string,
    memberId: string,
    reason: string,
  ) {
    mentor(p);
    text(reason, "Correction reason", 500);
    return atomic(this.store, async (tx) => {
      await this.livePrincipal(tx, p);
      const e = await tx.get(key(`EVENT#${eventId}`));
      assert(e, "Event not found.", 404);
      owns(p, e);
      const c = await tx.get(key(e.pk, `PARTICIPANT#${memberId}`));
      assert(c, "Participant not found.", 404);
      const award = await tx.get(key(`MEMBER#${memberId}`, c.creditSk));
      assert(award, "Award not found.", 409);
      await tx.put({
        ...award,
        status: "voided",
        voidReason: reason,
        voidedBy: p.id,
        voidedAt: this.clock().toISOString(),
      });
      await tx.del(key(c.pk, c.sk));
      await tx.put({ ...e, participantCount: e.participantCount - 1 });
      await this.audit(tx, p, "volunteer.voided", award.awardId, {
        reason,
        eventId,
      });
      return { removed: true };
    });
  }
  async review(p: Principal, input: any) {
    admin(p);
    assert(
      ["approved", "pending_review", "quarantined", "voided"].includes(
        input.status,
      ),
      "Invalid disposition.",
    );
    const reason = text(input.reason, "Review reason", 500);
    return atomic(this.store, async (tx) => {
      await this.livePrincipal(tx, p);
      const r = await tx.get(
        key(
          text(input.pk, "Record partition"),
          text(input.sk, "Record sort key"),
        ),
      );
      assert(
        r?.provenance &&
          ["LEGACYSHOP#", "VOLUNTEER#"].some((prefix) =>
            r.sk.startsWith(prefix),
          ),
        "Only imported credits may be reviewed here.",
        403,
      );
      if (input.status === "approved") {
        assert(
          Number.isSafeInteger(r.creditedSeconds) &&
            r.creditedSeconds >= 0 &&
            (r.shopDate || r.eventDate),
          "Missing date/duration and negative entries cannot be approved; provide a reviewed corrected export.",
          409,
        );
      }
      await tx.put({
        ...r,
        status: input.status,
        reviewedBy: p.id,
        reviewedAt: this.clock().toISOString(),
        reviewReason: reason,
      });
      const discovery = await tx.get(key("REVIEWS", r.provenance.importKey));
      if (discovery) await tx.put({ ...discovery, status: input.status });
      await this.audit(tx, p, "import.reviewed", r.provenance.importKey, {
        reason,
        status: input.status,
      });
      return { saved: true };
    });
  }
  async roster(p: Principal) {
    admin(p);
    const ms = await all(this.store, "MEMBERS", { index: "GSI1" });
    const result = [];
    for (const m of ms) {
      const current = await this.store.get(key(m.pk, "CURRENT"));
      if (current?.sessionId && current.cutoffAt > this.clock().toISOString())
        result.push({
          memberId: m.memberId,
          displayName: m.displayName,
          startedAt: current.lastResult.startedAt,
        });
    }
    return result;
  }
  async kioskOccupants(p: Principal) {
    assert(p.kind === "device", "Kiosk device authorization required.", 403);
    await atomic(this.store, async (tx) => {
      await this.livePrincipal(tx, p);
      await this.rate(tx, p);
    });
    const active = await all(this.store, "ACTIVE");
    const present: {
      memberId: string;
      displayName: string;
      cutoffAt: string;
      isMentor: boolean;
    }[] = [];
    for (let i = 0; i < active.length; i += 4) {
      const group = await Promise.all(
        active.slice(i, i + 4).map(async (entry) => {
          if (entry.cutoffAt <= this.clock().toISOString()) return undefined;
          const current = await this.store.get(
            key(`MEMBER#${entry.memberId}`, "CURRENT"),
          );
          if (
            !current?.sessionId ||
            current.sessionId !== entry.sessionId ||
            current.cutoffAt <= this.clock().toISOString()
          )
            return undefined;
          const [member, session] = await Promise.all([
            this.store.get(key(`MEMBER#${entry.memberId}`)),
            this.store.get(key(`MEMBER#${entry.memberId}`, current.sessionSk)),
          ]);
          if (
            !member ||
            (!member.active && !session?.isMentor) ||
            session?.status !== "active" ||
            session.sessionId !== current.sessionId ||
            session.cutoffAt <= this.clock().toISOString()
          )
            return undefined;
          return {
            memberId: member.memberId,
            displayName: member.displayName as string,
            cutoffAt: session.cutoffAt as string,
            isMentor: session.isMentor === true,
          };
        }),
      );
      for (const member of group) if (member) present.push(member);
    }
    const asOf = this.clock().toISOString();
    const unique = new Map(
      present
        .filter((member) => member.cutoffAt > asOf)
        .map((member) => [member.memberId, member]),
    );
    const members = [...unique.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, "en"),
    );
    const day = localDay(new Date(asOf));
    const shop = await this.store.get(shopClockKey(day));
    const validUntil = new Date(
      Math.min(Date.parse(asOf) + 15000, Date.parse(cutoff(day))),
    ).toISOString();
    // Explicit display DTO: never disclose IDs, cards, emails, roles, or session history.
    return {
      shopOpen: (shop?.mentorCount ?? 0) > 0,
      mentors: members
        .filter((member) => member.isMentor)
        .map(({ displayName }) => ({ displayName })),
      occupants: members
        .filter((member) => !member.isMentor)
        .map(({ displayName }) => ({ displayName })),
      asOf,
      validUntil,
    };
  }
}
