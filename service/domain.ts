import { type Store, Tx, atomic, all, Conflict } from "./store";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { assignCard } from "./card-codes";
import {
  type Row,
  type Principal,
  roles,
  staffsShop,
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
  kioskExpiry,
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
    if (p.kind === "human") {
      const user = await tx.get(key("USER#" + p.id));
      assert(
        user?.active && user.role === p.role,
        "Permissions changed or access was disabled. Sign in again.",
        403,
      );
      return user;
    }
    const device = await tx.get(key("DEVICE#" + p.id));
    assert(
      device?.enabled &&
        device.sessionType === "mentor-launch" &&
        device.launchedBy &&
        kioskExpiry(device.launchedAt, device.expiresAt) >
          this.clock().toISOString(),
      "Access disabled. Ask an administrator for setup.",
      403,
    );
    const owner = await tx.get(key("USER#" + device.launchedBy));
    assert(
      owner?.active && staffsShop(owner.role),
      "The mentor who launched this kiosk no longer has access.",
      403,
    );
    return device;
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
    assert(claim && !claim.retired, "Card is not assigned. Ask a mentor.", 404);
    return tx.get(key("USER#" + claim.memberId));
  }
  async memberForCard(tx: Tx, card: string) {
    const m = await this.cardMember(tx, card);
    assert(
      m?.active && m.role === "STUDENT",
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
        { id: "midnight-policy", kind: "device" },
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
    const k = key("ATTENDANCE#" + memberId, "CURRENT");
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
      const device = await this.livePrincipal(tx, p);
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
      assert(
        kioskExpiry(device.launchedAt, device.expiresAt) > now,
        "Kiosk session expired. Ask a mentor to activate it again.",
        401,
      );
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
        const isMentor = staffsShop(m.role);
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
      const c = await tx.get(key(`ATTENDANCE#${op.memberId}`, "CURRENT"));
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
          const c = await tx.get(key(`ATTENDANCE#${r.memberId}`, "CURRENT"));
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
  async updateMember(p: Principal, id: string, input: Record<string, unknown>) {
    admin(p);
    const displayName = text(input.displayName, "Name", 100);
    const role = roles.find((value) => value === input.role);
    assert(role, "Choose Student, Mentor, or Admin.");
    const active = input.active;
    assert(typeof active === "boolean", "Active is required.");
    return atomic(this.store, async (tx) => {
      await this.livePrincipal(tx, p);
      const user = await tx.get(key("USER#" + id));
      assert(user, "Member not found.", 404);
      assert(
        user.v === input.version,
        "This member changed. Refresh and try again.",
        409,
      );
      assert(
        id !== p.id || (active && role === "ADMIN"),
        "You cannot remove your own administrator access.",
        403,
      );
      if (user.active !== active || user.role !== role) {
        const current = await tx.get(key("ATTENDANCE#" + id, "CURRENT"));
        assert(
          !current?.sessionId || current.cutoffAt <= this.clock().toISOString(),
          "This member must clock out before you change their access.",
          409,
        );
      }
      await tx.put({ ...user, displayName, role, active });
      await this.audit(tx, p, "member.saved", id, { role, active });
      return { saved: true };
    });
  }
  async replaceCard(p: Principal, id: string, operationId: string) {
    admin(p);
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
          "Operation belongs to another roster entry.",
          409,
        );
        return existing.result;
      }
      const member = await tx.get(key("USER#" + id));
      assert(member, "Roster entry not found.", 404);
      const previous = await tx.get(key("CARD#" + member.barcode));
      assert(
        previous?.memberId === id && !previous.retired,
        "Card assignment is unavailable.",
        409,
      );
      const card = await assignCard(tx, id);
      await tx.put({ ...previous, retired: true });
      await tx.put({ ...member, barcode: card });
      await tx.put(
        row(opKey.pk, opKey.sk, { memberId: id, result: { barcode: card } }),
      );
      await this.audit(tx, p, "member.card_replaced", id);
      return { barcode: card };
    });
  }
  async clockInLaunchingMentor(tx: Tx, p: Principal, user: Row) {
    const { memberId, displayName } = user;
    const { day, shop, timestamp, now } = await this.readShopClock(tx);
    const { current } = await this.currentVisit(tx, memberId, now);
    const active = current.sessionId
      ? await tx.get(key(current.pk, current.sessionSk))
      : undefined;
    assert(
      !current.sessionId || (active?.status === "active" && active.isMentor),
      "Attendance state needs administrator attention.",
      409,
    );
    if (active) return now;
    await this.changeMentorCount(tx, day, shop, timestamp, 1);
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
    return now;
  }
  async issueKioskActivation(p: Principal) {
    mentor(p);
    const code = "PUNCHER-" + randomBytes(24).toString("hex").toUpperCase();
    const expires = new Date(this.clock().getTime() + 2 * 60_000);
    return atomic(this.store, async (tx) => {
      const { barcode } = await this.livePrincipal(tx, p);
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
    const identity = await this.store.get(key("USER#" + activation.mentorId));
    assert(
      identity?.active && staffsShop(identity.role),
      "The mentor who issued this code no longer has access.",
      403,
    );
    return this.launchKiosk(
      { kind: "human", id: activation.mentorId, role: identity.role },
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
      const now = await this.clockInLaunchingMentor(tx, p, identity);
      const resumed =
        !!previous &&
        (!previous.launchedAt ||
          localDay(new Date(previous.launchedAt)) ===
            localDay(new Date(now))) &&
        expected.length === actual.length &&
        timingSafeEqual(expected, actual);
      const id = resumed ? oldId : generatedId;
      const expiresAt = kioskExpiry(
        now,
        new Date(Date.parse(now) + 12 * 3600000).toISOString(),
      );
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
      return { sessionId: id, resumed, expiresAt };
    });
    return {
      credential: `${session.sessionId}.${secret}`,
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
        (p.kind === "human" && p.role === "ADMIN") || d.launchedBy === p.id,
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
      const c = row("ATTENDANCE#" + m.memberId, creditSk, {
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
      const award = await tx.get(key("ATTENDANCE#" + memberId, c.creditSk));
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
    const ms = await all(this.store, "USERS", { index: "GSI1" });
    const result = [];
    for (const m of ms) {
      const current = await this.store.get(
        key("ATTENDANCE#" + m.memberId, "CURRENT"),
      );
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
            key(`ATTENDANCE#${entry.memberId}`, "CURRENT"),
          );
          if (
            !current?.sessionId ||
            current.sessionId !== entry.sessionId ||
            current.cutoffAt <= this.clock().toISOString()
          )
            return undefined;
          const [member, session] = await Promise.all([
            this.store.get(key(`USER#${entry.memberId}`)),
            this.store.get(
              key(`ATTENDANCE#${entry.memberId}`, current.sessionSk),
            ),
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
