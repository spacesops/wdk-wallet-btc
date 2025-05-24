import { jest } from '@jest/globals'
import { EventEmitter } from 'events'

export const createSocket = () => {
  const socket = new EventEmitter()
  socket.setTimeout = jest.fn()
  socket.write = jest.fn()
  socket.end = jest.fn()
  socket.destroy = jest.fn()
  return socket
}

export const sockets = []

const connect = jest.fn(() => {
  const socket = createSocket()
  sockets.push(socket)
  return socket
})

export { connect }
export default { connect }
