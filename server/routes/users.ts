import express, { Request, Response } from 'express'
import { IUser, PlanType, User, UserRole } from '../db/models/user'
import { generateToken, getPayloadFromToken, getTokenFromRequest } from '../utils/jwtUtils'
import { validateUser } from '../utils/validators/userValidator'
import bcrypt from 'bcrypt'
import multer from 'multer'
import { Storage } from '@google-cloud/storage'
import { userErrors } from '../utils/errorMessages/users'
import { v4 as uuidv4 } from 'uuid'
import { Message } from '../db/models/message'
import { sendMessage } from '../rabbitmq/operations'
import { messagesErrors } from '../utils/errorMessages/messages'

const brevo = require('sib-api-v3-sdk');
let defaultClient = brevo.ApiClient.instance;

let apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.SENDINBLUE_API_KEY ?? '';

function getHTML(){
    return '<html><body><p>Hi {{ params.firstName | default : "NAME" }} {{ params.lastName | default : "SURNAME" }},</p><p>We have recovered your password. Please use the following credentials to authenticate in <a href="https://fisg4.javiercavlop.com">https://fisg4.javiercavlop.com</a>:</p><p> username: {{ params.username | default : "USERNAME" }}</p><p> password: {{ params.password | default : "PASSWORD" }}</p></br><p>Please do not respond to this email,</p><p><strong>FIS G4 - TEAM</strong></p></body></html>    '
}

const bucketUrl = process.env.GCS_BUCKET_URL ?? ''
const bucketName = process.env.GCS_BUCKET_NAME ?? ''

const storage = new Storage({
    projectId: process.env.GCS_PROJECT_NAME ?? '',
    keyFilename: '../GoogleCloudKey.json',
})

const bucket = storage.bucket(bucketName ?? '')

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024, // 5 MB
    },
})

interface FormInputs {
    username: string
    password: string
}

const router = express.Router()

const SALT_ROUNDS: number = parseInt(process.env.SALT_ROUNDS ?? '10')
const salt = bcrypt.genSaltSync(SALT_ROUNDS)

const EMPTY_USER: IUser = {
    firstName: '',
    lastName: '',
    username: '',
    password: '',
    email: '',
    profilePicture: bucketUrl + '/' + bucketName + '/default-user.jpg',
    coinsAmount: 0,
    plan: PlanType.BASIC,
    role: UserRole.USER,
}

/**
 * @swagger
 * components:
 *   schemas:
 *     UserLogin:
 *       type: object
 *       required:
 *         - username
 *         - password
 *       properties:
 *         username:
 *           type: string
 *           description: The username of the user
 *         password:
 *           type: string
 *           description: The password of the user
 *       example:
 *         username: johndoe
 *         password: johnpassword
 *     UserPost:
 *       type: object
 *       required:
 *         - firstName
 *         - lastName
 *         - username
 *         - password
 *         - email
 *       properties:
 *         firstName:
 *           type: string
 *           description: The first name of the user
 *         lastName:
 *           type: string
 *           description: The last name of the user
 *         username:
 *           type: string
 *           description: The username of the user
 *         password:
 *           type: string
 *           description: The password of the user
 *         email:
 *           type: string
 *           description: The email of the user
 *           format: email
 *       example:
 *         firstName: John
 *         lastName: Doe
 *         username: johndoe
 *         password: johnpassword
 *         email: johndoe@test.com
 *     UserPut:
 *       type: object
 *       properties:
 *         firstName:
 *           type: string
 *           description: The first name of the user
 *         lastName:
 *           type: string
 *           description: The last name of the user
 *         currentPassword:
 *           type: string
 *           description: The password of the user
 *         newPassword:
 *            type: string
 *            description: The new password of the user
 *         email:
 *           type: string
 *           description: The email of the user
 *           format: email
 *         profilePicture:
 *           type: string
 *           description: The profile picture of the user
 *           format: url
 *       example:
 *         firstName: John
 *         lastName: Doe
 *         currentPassword: johnpassword
 *         newPassword: newpassword
 *         email: johndoe@test.com
 *         profilePicture: https://storage.googleapis.com/fisg4-bucket/default-user.jpg
 *     UserPutAdmin:
 *       type: object
 *       properties:
 *         firstName:
 *           type: string
 *           description: The first name of the user
 *         lastName:
 *           type: string
 *           description: The last name of the user
 *         currentPassword:
 *           type: string
 *           description: The password of the user
 *         newPassword:
 *           type: string
 *           description: The new password of the user
 *         email:
 *           type: string
 *           description: The email of the user
 *           format: email
 *         plan:
 *           type: string
 *           description: The plan of the user
 *           enum: [BASIC, ADVANCED, PRO]
 *         role:
 *           type: string
 *           description: The role of the user
 *           enum: [USER, ADMIN]
 *         profilePicture:
 *           type: string
 *           description: The profile picture of the user
 *           format: url
 *         coinsAmount:
 *           type: number
 *           description: The coins amount of the user
 *       example:
 *         firstName: John
 *         lastName: Doe
 *         currentPassword: johnpassword
 *         newPassword: newpassword
 *         email: johndoe@test.com
 *         plan: BASIC
 *         role: USER
 *         profilePicture: https://storage.googleapis.com/fisg4-bucket/default-user.jpg
 *         coinsAmount: 0
 *     User:
 *       type: object
 *       required:
 *         - firstName
 *         - lastName
 *         - username
 *         - email
 *         - plan
 *         - role
 *         - profilePicture
 *         - coinsAmount
 *       properties:
 *         id:
 *           type: string
 *           description: The auto-generated id of the user
 *         firstName:
 *           type: string
 *           description: The first name of the user
 *         lastName:
 *           type: string
 *           description: The last name of the user
 *         username:
 *           type: string
 *           description: The username of the user
 *         email:
 *           type: string
 *           description: The email of the user
 *           format: email
 *         plan:
 *           type: string
 *           description: The plan of the user
 *           enum: [BASIC, ADVANCED, PRO]
 *         role:
 *           type: string
 *           description: The role of the user
 *           enum: [USER, ADMIN]
 *         profilePicture:
 *           type: string
 *           description: The profile picture of the user
 *           format: url
 *         coinsAmount:
 *           type: number
 *           description: The coins amount of the user
 *       example:
 *         id: 60b0a1b7c9e8a1b9c8a1b9c8
 *         firstName: John
 *         lastName: Doe
 *         username: johndoe
 *         email: johndoe@test.com
 *         plan: BASIC
 *         role: USER
 *         profilePicture: https://storage.googleapis.com/fisg4-bucket/default-user.jpg
 *         coinsAmount: 0
 *     UserMinimal:
 *       type: object
 *       required:
 *         - username
 *         - profilePicture
 *       properties:
 *         username:
 *           type: string
 *           description: The username of the user
 *         profilePicture:
 *           type: string
 *           description: The profile picture of the user
 *           format: url
 *       example:
 *         username: johndoe
 *         profilePicture: https://storage.googleapis.com/fisg4-bucket/default-user.jpg
 *     UserList:
 *       type: object
 *       required:
 *         - data
 *       properties:
 *         data:
 *           type: object
 *           description: The user
 *           $ref: '#/components/schemas/User'
 *     UserAllList:
 *       type: object
 *       required:
 *         - data
 *       properties:
 *         data:
 *           type: list
 *           description: The user list
 *           items:
 *              $ref: '#/components/schemas/UserMinimal'
 *     JWTList:
 *       type: object
 *       required:
 *         - data
 *       properties:
 *         data:
 *           type: object
 *           required:
 *             - token
 *             - user
 *           properties:
 *             token:
 *               description: The JWT token
 *               example: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2Vybm...
 *             user:
 *               description: The user
 *               $ref: '#/components/schemas/User'
 */

/**
 * @swagger
 * tags:
 *   name: Users
 *   description: The users managing API
 */

// ------------------ GET ROUTES ------------------

/**
 * @swagger
 * /me:
 *   get:
 *     summary: Returns the info of the user that is logged in
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: The info was successfully retrieved
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserList'
 *       400:
 *         description: There was an error with the request
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error400'
 *       404:
 *         description: The item was not found
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error404'
 *       401:
 *         description: The request was not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       500:
 *         description: Some server error
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error500'
 */
router.get('/check', async (req: Request, res: Response) => {
    return res.status(200).json({ message: "The users service is working properly" })
})

router.get('/me', async (req: Request, res: Response) => {
    let decodedToken: IUser = await getPayloadFromToken(getTokenFromRequest(req) ?? "")

    User.findOne({ username: decodedToken.username })
        .select('-password')
        .then((user) => {
            if (!user) {
                return res
                    .status(404)
                    .send({ error: userErrors.userNotExistError })
            }

            return res.status(200).json({ data: user })
        })
        .catch((err) => {
            return res.status(400).send({
                error: err ?? 'Something went wrong while getting the user',
            })
        })
})

/**
 * @swagger
 * /reset?username={username}:
 *   get:
 *     summary: Sends an email with the new credentials
 *     tags: [Users]
 *     parameters:
 *       - in: query
 *         name: username
 *         description: The username of the user to reset the password
 *         required: true
 *         schema:
 *           type: string
 *           example: johndoe
 *     security: []
 *     responses:
 *       200:
 *         description: The user was successfully alerted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OK2XX'
 *       400:
 *         description: There was an error with the request
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error400'
 *       404:
 *         description: The item was not found
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error404'
 *       401:
 *         description: The request was not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       500:
 *         description: Some server error
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error500'
 */

router.get('/reset', async (req: Request, res: Response) => {
    let username = req.query.username as string
    let user = await User.findOne({ username: username });

    if(!user){
        return res.status(404).send({ error: userErrors.userNotExistError })
    }

    let randomPassword = Math.random().toString(36).slice(-8);  

    user.password = bcrypt.hashSync(randomPassword, salt)

    try{
        await user.save()
    }catch(err){
        return res.status(400).send({ error: err })
    }

    let apiInstance = new brevo.TransactionalEmailsApi();
    let sendSmtpEmail = new brevo.SendSmtpEmail();
    
    sendSmtpEmail.subject = "Reset your password - FIS G4";
    sendSmtpEmail.htmlContent = getHTML();
    sendSmtpEmail.sender = { "name": "FIS G4 - TEAM", "email": "fisg4microservices@gmail.com" };
    sendSmtpEmail.to = [
      { "email": user.email, "name": user.__v.fullName }
    ];
    sendSmtpEmail.params = { 
        "username": user.username,
        "password": randomPassword,
        "firstName": user.firstName,
        "lastName": user.lastName
     };
    

    apiInstance.sendTransacEmail(sendSmtpEmail).then((data: any) => {
        return res.status(200).json({ message: 'Password reset!' })
    }).catch((error: any) => {
        return res.status(400).send({ error: error })
    });
});

/**
 * @swagger
 * /all:
 *   get:
 *     summary: Returns minimal info of all users
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: The info was successfully retrieved
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserAllList'
 *       400:
 *         description: There was an error with the request
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error400'
 *       404:
 *         description: The item was not found
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error404'
 *       401:
 *         description: The request was not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       500:
 *         description: Some server error
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error500'
 */

/**
 * @swagger
 * /{username}:
 *   get:
 *     summary: Returns the info of the user that has the username passed as parameter
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: username
 *         schema:
 *           type: string
 *         required: true
 *         description: The username of the user to get
 *         example: johndoe
 *     responses:
 *       200:
 *         description: The info was successfully retrieved
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserList'
 *       400:
 *         description: There was an error with the request
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error400'
 *       404:
 *         description: The item was not found
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error404'
 *       401:
 *         description: The request was not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       500:
 *         description: Some server error
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error500'
 */
router.get('/:username', async (req: Request, res: Response) => {
    if(req.params.username === 'all') {
        const me = await getPayloadFromToken(getTokenFromRequest(req) ?? "")
        User.find({role: UserRole.USER})
            .select('username profilePicture')
            .then((users) => {
                if (!users) {
                    return res
                        .status(404)
                        .send({ error: userErrors.userNotExistError })
                }

                return res.status(200).json({ data: users.filter((user) => user.username !== me.username) })
            })
            .catch((err) => {
                return res.status(400).send({
                    error: err ?? 'Something went wrong while getting the user',
                })
            })
    } else{
        User.findOne({ username: req.params.username })
            .select('-password')
            .then((user) => {
                if (!user) {
                    return res
                        .status(404)
                        .send({ error: userErrors.userNotExistError })
                }

                return res.status(200).json({ data: user })
            })
            .catch((err) => {
                return res.status(400).send({
                    error: err ?? 'Something went wrong while getting the user',
                })
            })
    }
})

// ------------------ POST ROUTES ------------------
/**
 * @swagger
 * /new:
 *   post:
 *     summary: Creates a new user
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserPost'
 *     security: []
 *     responses:
 *       201:
 *         description: The user was successfully created (returns the JWT token)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/JWTList'
 *       400:
 *         description: There was an error with the request
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error400'
 *       404:
 *         description: The item was not found
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error404'
 *       401:
 *         description: The request was not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       500:
 *         description: Some server error
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error500'
 */
router.post('/new', async (req: Request, res: Response) => {
    let userData: IUser = req.body

    userData = { ...EMPTY_USER, ...userData, role: UserRole.USER }

    await validateUser(userData, res)

    if (res.statusCode !== 200) {
        return res
    } else {
        const hash = bcrypt.hashSync(userData.password, salt)

        userData.password = hash

        const user = User.build(userData)

        user.save()

        let userCreated = {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            email: user.email,
            profilePicture: user.profilePicture,
            coinsAmount: user.coinsAmount,
            plan: user.plan
        }


        generateToken(user).then((token) => {
            return res.status(201).json({ data: {token: token, user: userCreated } })
        }).catch((err) => {
            return res.status(500).send({ error: err })
        })

    }
})

/**
 * @swagger
 * /login:
 *   post:
 *     summary: Logs in the user
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserLogin'
 *     security: []
 *     responses:
 *       200:
 *         description: The user was successfully logged in (returns the JWT token)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/JWTList'
 *       400:
 *         description: There was an error with the request
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error400'
 *       404:
 *         description: The item was not found
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error404'
 *       401:
 *         description: The request was not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       500:
 *         description: Some server error
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error500'
 */
router.post('/login', async (req: Request, res: Response) => {
    const { username, password }: FormInputs = req.body

    User.findOne({ username: username }).then((user) => {
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res
                .status(400)
                .send({ error: userErrors.invalidUsernameOrPasswordError })
        }

        let userData = {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            username: user.username,
            email: user.email,
            profilePicture: user.profilePicture,
            coinsAmount: user.coinsAmount,
            plan: user.plan
        }

        generateToken(user).then((token) => {
            return res.status(200).json({ data: {token: token, user: userData }})
        }).catch((err) => {
            return res.status(500).send({ error: err })
        });


    })
})

// ------------------ PUT ROUTES ------------------
/**
 * @swagger
 * /me:
 *   put:
 *     summary: Updates the info of the user that is logged in
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserPut'
 *     responses:
 *       200:
 *         description: The info was successfully updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OK2XX'
 *       400:
 *         description: There was an error with the request
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error400'
 *       403:
 *         description: The user that made the request has not enough privileges
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 *       404:
 *         description: The item was not found
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error404'
 *       401:
 *         description: The request was not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       500:
 *         description: Some server error
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error500'
 */
router.put(
    '/me',
    upload.single('profilePicture'),
    async (req: Request, res: Response) => {
        let decodedToken: IUser = await getPayloadFromToken(getTokenFromRequest(req) ?? "")

        if (req.file) {
            
            const blob = bucket.file(uuidv4() + '-' + req.file.originalname)

            const blobStream = blob.createWriteStream({
                resumable: false,
            })

            blobStream.on('error', (err) => {
                return res.status(500).send({ error: err })
            })

            blobStream.on('finish', async () => {
                const publicUrl = `${bucketUrl}/${bucket.name}/${blob.name}`

                req.body.profilePicture = publicUrl

                updateUser(decodedToken.username, req.body, res)
                    .then(() => {
                        return res
                    })
                    .catch((err) => {
                        return res.status(400).send({ error: err })
                    })
            })

            blobStream.end(req.file.buffer)
        } else {

            if (req.body.plan){
                return res.status(403).send({ error: userErrors.cannotUpdatePlanError })
            }

            updateUser(decodedToken.username, req.body, res)
                .then(() => {
                    return res
                })
                .catch((err) => {
                    return res.status(400).send({ error: err })
                })
        }
    }
)

/**
 * @swagger
 * /{username}:
 *   put:
 *     summary: Updates the info of the user that has the username passed as parameter
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: username
 *         schema:
 *           type: string
 *         required: true
 *         description: The username of the user to update
 *         example: johndoe
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserPutAdmin'
 *     responses:
 *       200:
 *         description: The info was successfully updated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OK2XX'
 *       400:
 *         description: There was an error with the request
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error400'
 *       403:
 *         description: The user that made the request has not enough privileges
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 *       404:
 *         description: The item was not found
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error404'
 *       401:
 *         description: The request was not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       500:
 *         description: Some server error
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error500'
 */
router.put('/:username', async (req: Request, res: Response) => {
    let decodedToken: IUser = await getPayloadFromToken(getTokenFromRequest(req) ?? "")

    if (decodedToken.role !== UserRole.ADMIN) {
        return res.status(401).send({ error: userErrors.cannotUpdateUserError })
    }

    delete req.body.profilePicture
    delete req.body.password

    updateUser(req.params.username, req.body, res)
        .then(() => {
            return res
        })
        .catch((err) => {
            return res.status(400).send({ error: err })
        })
})

// ------------------ DELETE ROUTES ------------------
/**
 * @swagger
 * /me:
 *   delete:
 *     summary: Deletes the user that is logged in
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: The user was successfully deleted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OK2XX'
 *       400:
 *         description: There was an error with the request
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error400'
 *       404:
 *         description: The item was not found
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error404'
 *       401:
 *         description: The request was not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       500:
 *         description: Some server error
 *         content:
 *           application/json:
 *             schema:
 *              $ref: '#/components/schemas/Error500'
 */
router.delete('/me', async (req: Request, res: Response) => {
    let decodedToken: IUser = await getPayloadFromToken(getTokenFromRequest(req) ?? "")

    User.findOneAndDelete({ username: decodedToken.username })
        .then(() => {
            Message.deleteMany({ $or: [{ sender: decodedToken.username }, { receiver: decodedToken.username }] })
            .then(() => {
                const data = {
                    username: decodedToken.username
                }
                sendMessage('user/notification', 'notificationUserDeletion', process.env.API_KEY ?? '', JSON.stringify(data))
                return res.status(200).json({ message: 'User deleted!' })
            }).catch((err) => {
                return res.status(400).send({ error: err })
            });
        })
        .catch((err) => {
            return res.status(400).send({ error: userErrors.userNotExistError })
        })
})

async function updateUser(username: string, userData: any, res: Response) {
    
    if (!userData) {
        return res.status(400).send({ error: userErrors.noUserDataError })
    }

    // This is to avoid updating the username
    if (userData.username) {
        delete userData.username
    }

    User.findOne({ username: username })
        .then(async (user: IUser | null) => {

            if (!user) {
                return res
                    .status(404)
                    .send({ error: userErrors.userNotExistError })
            }

            let changedUsername = false
            let changedEmail = false

            for (let key in userData) {
                if (key !== 'password' && user[key] !== userData[key]) {
                    if (key === 'username') {
                        changedUsername = true
                    } else if (key === 'email') {
                        changedEmail = true
                    }
                    user[key] = userData[key]
                }
            }

            if (userData.newPassword && userData.newPassword.trim() === "") {
                if(!userData.currentPassword){
                    return res
                        .status(400)
                        .send({ error: userErrors.invalidCurrentPasswordError })
                }
                if (!bcrypt.compareSync(userData.currentPassword, user.password)) {
                    return res
                        .status(400)
                        .send({ error: userErrors.invalidCurrentPasswordError })
                }else{
                    user.password = bcrypt.hashSync(userData.newPassword, salt)
                }
            }

            await validateUser(user, res, true)

            if (res.statusCode !== 200) {
                return res
            } else {
                if (user.role === UserRole.ADMIN) {
                    return res
                        .status(403)
                        .send({ error: userErrors.cannotUpdateUserError })
                }

                if (
                    changedUsername &&
                    (await User.findOne({ username: user.username })) !== null
                ) {
                    return res
                        .status(400)
                        .send({ error: userErrors.existingUsernameError })
                }

                if (
                    changedEmail &&
                    (await User.findOne({ email: user.email })) !== null
                ) {
                    return res
                        .status(400)
                        .send({ error: userErrors.existingEmailError })
                }

                User.updateOne({ username: username }, user)
                    .then(() => {
                        generateToken(user).then((token) => {
                            res.setHeader('Authorization', `Bearer ${token}`)
                            return res
                                .status(200)
                                .json({ message: 'User updated!' })
                        }).catch((err) => {
                            console.error(err)
                        })
                    })
                    .catch((err) => {
                        return res.status(400).send({
                            error:
                                err ??
                                'Something went wrong while updating the user',
                        })
                    })
            }
        })
        .catch((err) => {
            return res.status(400).send({
                error: err ?? 'Something went wrong while updating the user',
            })
        })
}

export default router
