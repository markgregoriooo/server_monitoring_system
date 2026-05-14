import bcrypt from "bcrypt";

const password = "ictuadmin123";

const hashPassword = async () => {
  const hashed = await bcrypt.hash(password, 10);
  console.log(hashed);
};

hashPassword();

$2b$10$8/Tlp6itKUYAeVWCEEERveHP6l71eVP2A3D5QgmWKk75VceHjSkaK