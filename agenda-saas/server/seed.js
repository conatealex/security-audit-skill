import { randomUUID, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createDb, one, transaction, audit } from "./db.js";
import { createWorkspace, book, decide } from "./domain.js";
import { localDate, addDays, zonedToUtc } from "./time.js";
import { digest } from "./security.js";

export async function seedDemo(db) {
  if (process.env.NODE_ENV === "production")
    throw new Error("Dados demonstrativos não são permitidos em produção.");
  if (await one(db, "SELECT id FROM tenants WHERE slug=$1", ["clinica-aurora"]))
    return false;
  const owner = await createWorkspace(db, {
    workspace: "Clínica Aurora",
    name: "Camila Duarte",
    email: "admin@aurora.demo",
    password: randomBytes(24).toString("base64"),
    privacy: true,
  });
  const other = await createWorkspace(db, {
    workspace: "Espaço Viver",
    name: "Administrador Viver",
    email: "admin@outra-clinica.demo",
    password: randomBytes(24).toString("base64"),
    privacy: true,
  });
  await db.query("UPDATE tenants SET slug=$1 WHERE id=$2", [
    "espaco-viver",
    other.tenantId,
  ]);
  await db.query("UPDATE professionals SET specialty=$1,color=$2 WHERE id=$3", [
    "Psicologia",
    "#217A70",
    owner.professionalId,
  ]);
  await db.query("UPDATE professionals SET name=$1 WHERE id=$2", [
    "Camila Duarte",
    owner.professionalId,
  ]);
  await db.query("UPDATE services SET name=$1,price_cents=18000 WHERE id=$2", [
    "Consulta inicial",
    owner.serviceId,
  ]);
  const marinaId = randomUUID(),
    marinaUser = randomUUID(),
    rafaelId = randomUUID();
  await transaction(db, async (tx) => {
    await tx.query(
      "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
      [marinaUser, "marina@aurora.demo", "Marina Costa", "!disabled-login"],
    );
    await tx.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)",
      [owner.tenantId, marinaUser, "professional"],
    );
    await tx.query(
      "INSERT INTO professionals(id,tenant_id,user_id,name,specialty,color) VALUES($1,$2,$3,$4,$5,$6)",
      [
        marinaId,
        owner.tenantId,
        marinaUser,
        "Marina Costa",
        "Neuropsicologia",
        "#7764AA",
      ],
    );
    await tx.query(
      "INSERT INTO professionals(id,tenant_id,name,specialty,color) VALUES($1,$2,$3,$4,$5)",
      [rafaelId, owner.tenantId, "Rafael Mendes", "Psicologia", "#BC8546"],
    );
    for (const p of [marinaId, rafaelId])
      for (let d = 1; d <= 6; d++)
        for (const [s, e] of [
          [540, 720],
          [840, 1080],
        ])
          await tx.query(
            "INSERT INTO working_hours(id,tenant_id,professional_id,weekday,start_minute,end_minute) VALUES($1,$2,$3,$4,$5,$6)",
            [randomUUID(), owner.tenantId, p, d, s, e],
          );
    for (const [name, duration, buffer, price] of [
      ["Avaliação neuropsicológica", 90, 15, 28000],
      ["Sessão de acompanhamento", 50, 10, 16000],
      ["Orientação familiar", 60, 15, 20000],
    ])
      await tx.query(
        "INSERT INTO services(id,tenant_id,name,duration_minutes,buffer_minutes,price_cents) VALUES($1,$2,$3,$4,$5,$6)",
        [randomUUID(), owner.tenantId, name, duration, buffer, price],
      );
  });
  const tenant = await one(db, "SELECT * FROM tenants WHERE id=$1", [
    owner.tenantId,
  ]);
  const auth = {
    tenant_id: owner.tenantId,
    userId: owner.userId,
    role: "owner",
    type: "user",
  };
  const today = localDate(new Date(), tenant.timezone);
  const workday = (offset) => {
    let d = today;
    for (let i = 0; i < offset; i++) {
      d = addDays(d, 1);
      while ([0, 6].includes(new Date(d + "T12:00:00Z").getUTCDay()))
        d = addDays(d, 1);
    }
    return d;
  };
  const entries = [
    [0, "09:00", owner.professionalId, "Ana Beatriz", "confirmada"],
    ["0", "10:00", marinaId, "Lucas Oliveira", "confirmada"],
    ["0", "11:00", rafaelId, "Mariana Santos", "pendente"],
    ["0", "14:00", owner.professionalId, "Pedro Henrique", "confirmada"],
    ["0", "15:00", marinaId, "Julia Almeida", "pendente"],
    ["0", "16:00", rafaelId, "Beatriz Lima", "confirmada"],
    ["1", "09:00", owner.professionalId, "Camila Rodrigues", "pendente"],
    ["1", "10:00", marinaId, "Gabriel Ferreira", "confirmada"],
    ["1", "11:00", rafaelId, "Sofia Martins", "pendente"],
    ["1", "14:00", owner.professionalId, "Rafael Costa", "confirmada"],
    ["2", "09:00", marinaId, "Isabela Ribeiro", "confirmada"],
    ["2", "10:00", owner.professionalId, "Matheus Gomes", "pendente"],
    ["3", "14:00", rafaelId, "Laura Barbosa", "confirmada"],
    ["4", "11:00", marinaId, "Felipe Azevedo", "pendente"],
  ];
  let n = 0;
  for (const [offset, time, person, name, status] of entries) {
    const date = workday(Number(offset));
    const result = await book(
      db,
      tenant,
      {
        professionalId: person,
        serviceId: owner.serviceId,
        date,
        time,
        name,
        phone: `+551199999${String(++n).padStart(4, "0")}`,
        notes: "",
        whatsappOptIn: true,
        idempotencyKey: randomUUID(),
      },
      digest(`demo-${n}`),
      zonedToUtc(date, 0, tenant.timezone),
    );
    const id = result.appointment.id;
    if (status === "confirmada") await decide(db, auth, id, "confirm");
    if (
      Number(offset) === 0 &&
      new Date(result.appointment.startsAt) < new Date()
    ) {
      if (status === "pendente") await decide(db, auth, id, "confirm");
      await decide(db, auth, id, "complete");
    }
  }
  await book(
    db,
    await one(db, "SELECT * FROM tenants WHERE id=$1", [other.tenantId]),
    {
      professionalId: other.professionalId,
      serviceId: other.serviceId,
      date: workday(1),
      time: "09:00",
      name: "Cliente fictício de outra clínica",
      phone: "+5511988880000",
      notes: "Registro isolado para teste de segurança.",
      whatsappOptIn: false,
      idempotencyKey: randomUUID(),
    },
    digest("other-demo"),
    zonedToUtc(workday(1), 0, tenant.timezone),
  );
  return true;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const db = await createDb();
  try {
    console.log(
      (await seedDemo(db))
        ? "Demonstração criada com dados fictícios."
        : "Demonstração já existe; nenhum dado foi sobrescrito.",
    );
  } finally {
    await db.close();
  }
}
