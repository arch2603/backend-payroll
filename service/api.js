const API_URL = "http://localhost:3001"; // change to server IP later

export async function fetchPayroll() {
  const res = await fetch(`${API_URL}/payroll`);
  return res.json();
}
