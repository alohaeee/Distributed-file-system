// константы
export const port = 8080;
export const host = '0.0.0.0';


export const ID = process.env.ID;
// Обращаемся к отдельной папке на хосте
export const CONTENT_DIR = "./uploads/" + ID;

export let Topics = {
    all: "all",
    

};
export default { CONTENT_DIR, Topics, ID, port, host};