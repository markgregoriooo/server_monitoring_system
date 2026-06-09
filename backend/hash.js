import bcrypt from "bcrypt";

const password = "ictuadmin123";

const hashPassword = async () => {
  const hashed = await bcrypt.hash(password, 10);
  console.log(hashed);
};

hashPassword();

// $2b$10$.9xknj/Hvs52X/VWp9Xfc.oS1DcUJREfz8eTZFLg2Lro6ZcO8GuXG